// B2 (user decision 2026-11-11): empty-collection first takeover, with a persisted
// initialization fact so a PARTIALLY LOST collection (one that still carries install
// residue) cannot be mistaken for a first install.
//
// Guarantee boundary — read this before quoting the module
// --------------------------------------------------------
// The residue check catches: marker/keys deleted while any install field survives. It does
// NOT catch a full rollback of the whole database, because a rollback takes the install
// fields with it. Distinguishing "never installed" from "installed then rolled back" needs
// an independent trusted install fact or an anti-rollback anchor, which this module does
// not have and does not pretend to have.
//
// `replayInstallId` is an installation DIAGNOSTIC label: it is copied along with the whole
// database, so it can never by itself detect a foreign copy or a rollback. Do not cite it
// as forgery detection.
//
// Why this module exists
// ----------------------
// The R10 prototype (`scripts/qzone-r10-candidate-b-guard.mjs`) had one behaviour that is
// wrong for production:
//
//     if (state.usedReadKeys === undefined) return { ...state, usedReadKeys: {} };
//
// That treats "the replay set is missing" and "we have never installed a replay set" as
// the SAME case. For first install that is fine. After a crash, a bad write, an operator
// deleting a file, or a rolled-back release, it silently recreates an EMPTY set — which
// reopens the replay window for every key that used to be in it.
//
// The user's decision requires exactly the opposite:
//   · first install      -> create an empty set (accepted historical-replay risk)
//   · already installed   -> never clear existing keys
//   · installed but lost  -> FAIL CLOSED, do not rebuild
//
// So the set and its initialization marker are written TOGETHER, and the marker is what
// distinguishes "never installed" from "installed then lost".
//
// What this module is NOT
// -----------------------
//   · NOT authentication. A key existing in the store only means "this key was seen".
//     Anything that can call `store.update` can insert keys (denial of service) or skip
//     this guard entirely. Source authentication is B3, a separate problem.
//   · NOT a growth-bounded structure. There is no TTL and no capacity eviction: dropping
//     a key reopens exactly one replay window, and only a scheme that can prove a record
//     is unreachable forever may do that. Growth is linear; see the plan doc for the
//     measurement task.
//   · NOT a substitute for quota / pause / cooldown / audit. It only answers
//     "has this exact (account, session, request, call) been claimed before?".

import { randomUUID } from 'node:crypto';

/** Bumped only when the persisted shape changes in an incompatible way. */
export const REPLAY_SCHEMA_VERSION = 1;
/** Where the marker and the keys live inside the host state object. */
const MARKER_FIELD = 'replaySchema';
const KEYS_FIELD = 'usedReadKeys';
/** Installation evidence. ANY of these being present means "this store was installed before". */
const INSTALLED_AT_FIELD = 'replayInitializedAt';
const INSTALL_ID_FIELD = 'replayInstallId';

const HEX32 = /^[0-9a-f]{32}$/;

/**
 * Every field that leaves a trace of a past installation.
 *
 * The earlier version only looked at MARKER_FIELD, and Codex reproduced this: deleting just
 * `replaySchema` + `usedReadKeys` while leaving `replayInitializedAt` made `inspect()` say
 * "uninitialized", so `initialize()` happily reported `created: true` and the same key could
 * be claimed again. Checking ALL residue fields closes that specific gap.
 *
 * This is NOT a defence against a full rollback of the whole database (a rollback takes the
 * install id with it). See the guarantee boundary in the plan doc.
 */
const INSTALL_RESIDUE_FIELDS = Object.freeze([MARKER_FIELD, KEYS_FIELD, INSTALLED_AT_FIELD, INSTALL_ID_FIELD]);

/**
 * Identity charset. Rejects every character that could be used as a delimiter, so a tuple
 * encoding can never collide. This is the fix for the second reproduced defect: the previous
 * `keyOf` only checked "non-empty string" and joined with newlines, so
 * `{sessionId:'s\nx', requestId:'r'}` and `{sessionId:'s', requestId:'x\nr'}` produced the
 * SAME key and the second identity was wrongly refused as a replay.
 *
 * Rejecting (rather than escaping) is deliberate: these ids come from the host and the bridge,
 * both of which already constrain them. A value carrying a control character or a newline is
 * not a legitimate id, and refusing it fails closed instead of silently normalising it.
 */
const ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;

const idOk = (value) => typeof value === 'string' && ID_RE.test(value);

/** Any trace of a previous installation? */
const hasInstallResidue = (state) => INSTALL_RESIDUE_FIELDS.some((f) => Object.hasOwn(state, f));


/**
 * Reason codes. All of them are refusals: when `claim()` cannot PROVE this key is fresh,
 * it must not let the caller execute.
 */
export const REPLAY_REFUSAL = Object.freeze({
  REPLAY: 'replay',                              // key already claimed
  UNINITIALIZED: 'uninitialized',                // no marker and no keys (needs init first)
  SCHEMA_MARKER_MISSING: 'schema-marker-missing',// keys exist without a marker -> provenance unknown
  SCHEMA_MISMATCH: 'schema-version-mismatch',    // marker from another version
  COLLECTION_LOST: 'collection-lost',            // marker exists, keys gone  -> do NOT rebuild
  COLLECTION_CORRUPT: 'collection-corrupt',      // keys present but not a plain object
  INVALID_IDENTITY: 'invalid-identity',
  INVALID_CLOCK: 'invalid-clock',
});

const refusal = (reason, extra) => Object.freeze({ ok: false, reason, ...extra });

/**
 * Read the persisted replay state WITHOUT mutating it.
 *
 * @returns {ok: true, keys: object} | {ok: false, reason: string}
 */
export function inspectReplayState(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return { ok: false, reason: REPLAY_REFUSAL.COLLECTION_CORRUPT };
  }
  const hasMarker = Object.hasOwn(state, MARKER_FIELD);
  const hasKeys = Object.hasOwn(state, KEYS_FIELD);

  // Never installed: NO trace of a past installation at all. Callers must run `initialize()`
  // first; claiming before that must refuse rather than auto-create (auto-create here is how
  // a lost set gets silently replaced).
  //
  // `hasInstallResidue` covers install markers, the init timestamp and the install id, so a
  // partial deletion cannot masquerade as a virgin store. Measured defect (Codex): deleting
  // only replaySchema + usedReadKeys while leaving replayInitializedAt used to report
  // `uninitialized`, letting `initialize()` create the set again and re-open the window.
  if (!hasInstallResidue(state)) return { ok: false, reason: REPLAY_REFUSAL.UNINITIALIZED };

  // Residue present but the marker is gone: a partial/corrupted installation. Do NOT treat
  // this as first install — that is exactly the "lost collection" case in disguise.
  if (!hasMarker) {
    return { ok: false, reason: hasKeys ? REPLAY_REFUSAL.SCHEMA_MARKER_MISSING : REPLAY_REFUSAL.COLLECTION_LOST };
  }

  // Keys without a marker: written by something that did not go through `initialize()`.
  // Provenance unknown -> refuse. (This is the legacy/partial-migration case; treating it
  // as first install would silently discard whatever those keys recorded.)
  if (!hasMarker && hasKeys) return { ok: false, reason: REPLAY_REFUSAL.SCHEMA_MARKER_MISSING };

  if (state[MARKER_FIELD] !== REPLAY_SCHEMA_VERSION) {
    return { ok: false, reason: REPLAY_REFUSAL.SCHEMA_MISMATCH, found: state[MARKER_FIELD] };
  }

  // Marker present, keys absent: the collection was lost after installation.
  // This is the case the prototype got wrong.
  if (!hasKeys) return { ok: false, reason: REPLAY_REFUSAL.COLLECTION_LOST };

  const keys = state[KEYS_FIELD];
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
    return { ok: false, reason: REPLAY_REFUSAL.COLLECTION_CORRUPT };
  }
  return { ok: true, keys };
}

/**
 * Install the replay collection for the FIRST time.
 *
 * Idempotent: if already installed it is a no-op and reports `created: false`. It MUST NOT
 * re-create a lost collection — that is the whole point of the marker.
 *
 * @returns {ok: true, created: boolean} | {ok: false, reason: string}
 */
export function initializeReplayState(store, { now } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('replay claim store needs a store with read/update');
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('initialize needs a valid now (trusted side, not client time)');
  }

  let result = null;
  store.update((state) => {
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      result = refusal(REPLAY_REFUSAL.COLLECTION_CORRUPT);
      return state;
    }
    // ANY install residue means "this store has been through initialization before".
    // Re-initializing then would silently reopen the replay window, so this branch covers
    // not only a healthy install but also every partial-damage shape. This is the fix for
    // the reproduced defect: leaving `replayInitializedAt` behind while deleting the marker
    // and the keys used to look like a virgin store.
    if (hasInstallResidue(state)) {
      const inspected = inspectReplayState(state);
      result = inspected.ok
        ? Object.freeze({ ok: true, created: false })
        : refusal(inspected.reason, { created: false });
      return state;
    }

    // Genuine first install. ONLY the replay fields are added; every other field of the host
    // state (quota counters, pause flags, cooldowns, audit, chat history) is preserved by the
    // spread order. `replayInstallId` is a random nonce so that two different stores are
    // distinguishable in audit, and so a copied-from-elsewhere state is detectable by eye.
    result = Object.freeze({ ok: true, created: true });
    return {
      ...state,
      [MARKER_FIELD]: REPLAY_SCHEMA_VERSION,
      [KEYS_FIELD]: {},
      [INSTALLED_AT_FIELD]: now,
      [INSTALL_ID_FIELD]: randomUUID(),
    };
  });
  return result;
}

/**
 * Build a claimer over one store + one account.
 *
 * `claim()` is SYNCHRONOUS and does the "is it free?" check and the write inside ONE
 * `store.update` call, so two racing claims cannot both succeed.
 */
export function createReplayClaimer({ store, accountId } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('replay claim store needs a store with read/update');
  }
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new TypeError('replay claim store needs a positive accountId (botQq)');
  }

  // The account is part of the key on purpose: one machine, one store directory, and
  // switching the QQ account must not make the new account's legitimate calls look like
  // replays of the old account's keys (nor let the old account's keys "carry over").
  // Unambiguous tuple encoding. The previous version joined raw strings with newlines and
  // only checked "non-empty", so `{sessionId:'s\nx', requestId:'r'}` and
  // `{sessionId:'s', requestId:'x\nr'}` produced the SAME key and the second identity was
  // wrongly refused as a replay (measured). Two defences now:
  //
  //   1. `JSON.stringify([...])` is injective over string tuples, so no delimiter can alias.
  //   2. every id must match ID_RE, which excludes newlines and control characters outright.
  //
  // Rejecting is deliberate: these ids come from the host and the bridge, both of which
  // constrain them. A value carrying a newline is not a legitimate id, and refusing it fails
  // closed instead of silently normalising it into someone else's key.
  function keyOf(identity) {
    const { sessionId, requestId, callId } = identity ?? {};
    if (!idOk(sessionId)) throw new TypeError('invalid sessionId');
    if (!idOk(requestId)) throw new TypeError('invalid requestId');
    if (!idOk(callId)) throw new TypeError('invalid callId');
    return JSON.stringify([accountId, sessionId, requestId, callId]);
  }

  return Object.freeze({
    /** Read-only probe: is this key already claimed? Never writes. */
    peek(identity) {
      const key = keyOf(identity);
      const inspected = inspectReplayState(store.read());
      if (!inspected.ok) return refusal(inspected.reason);
      return Object.freeze({ ok: true, claimed: Object.hasOwn(inspected.keys, key) });
    },

    /**
     * Claim exactly one (account, session, request, call).
     *
     * Returns `{ ok: true }` only when this call is the ONE that wrote the key. Any other
     * outcome is a refusal and the caller MUST NOT execute.
     *
     * `now` must come from the trusted side. It is recorded for audit only; the decision
     * is "does the key exist", never a time comparison.
     */
    claim(identity, { now } = {}) {
      if (!Number.isSafeInteger(now) || now < 0) return refusal(REPLAY_REFUSAL.INVALID_CLOCK);
      let key;
      try { key = keyOf(identity); } catch { return refusal(REPLAY_REFUSAL.INVALID_IDENTITY); }

      let outcome = null;
      store.update((state) => {
        const inspected = inspectReplayState(state);
        if (!inspected.ok) {
          // Fail closed: never auto-initialize here. A missing collection must block
          // execution, not silently become an empty one.
          outcome = refusal(inspected.reason);
          return state;
        }
        if (Object.hasOwn(inspected.keys, key)) {
          outcome = refusal(REPLAY_REFUSAL.REPLAY, { claimedAt: inspected.keys[key]?.claimedAt });
          return state; // a refused attempt writes nothing
        }
        outcome = Object.freeze({ ok: true });
        return {
          ...state,
          [KEYS_FIELD]: {
            ...inspected.keys,
            [key]: {
              // Audit-minimal: no content, no target, no result.
              claimedAt: now,
              // Generation is diagnostic only; never part of the decision.
              generation: identity?.generation ?? null,
            },
          },
        };
      });
      return outcome;
    },

    /** Diagnostic: how many keys are recorded. There is no eviction, so this only grows. */
    size() {
      const inspected = inspectReplayState(store.read());
      return inspected.ok ? Object.keys(inspected.keys).length : -1;
    },
  });
}

export { HEX32 as _HEX32 };
