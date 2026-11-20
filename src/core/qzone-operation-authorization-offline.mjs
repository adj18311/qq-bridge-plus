// B3 host-approved operation authorization (offline composition only).
//
// WHY THIS MODULE EXISTS
// ----------------------
// `qzone-runtime-wiring.mjs` can be composed with an optional host approval hook. The host
// sees a FROZEN semantic operation, and the runtime must then prove, per platform call, that
// (a) the operation the host approved is still exactly the operation about to execute, and
// (b) the durable B2 claim for this (account, session, request, call) quadruple was taken by
// THIS ticket, before any platform I/O happens.
//
// So `prepare()` mints an opaque ticket, and `verify()` / `claim()` answer two different
// questions:
//
//   verify(ticket, expected)  "is this still the approved operation?"   (no side effects)
//   claim(ticket, expected)   "may I send?"                              (takes the B2 key once)
//
// A logical read performs several platform calls (friendship proof, list/detail, exception
// adapters), so the runtime calls `claim()` before EACH of them. Re-claiming the same ticket
// while it is still valid must therefore succeed without consuming a second key: the durable
// key is per quadruple, and the first successful claim owns it.
//
// TRUST ASSUMPTIONS — read this before quoting the module
// ------------------------------------------------------
//   · The host and the `approveOperation` callback are TRUSTED. This module does not verify
//     that a human (or any principal the host cares about) actually approved anything; it
//     checks the callback's verdict and binds the operation, nothing more.
//   · It does NOT prove the model really proposed this call. The input it binds is whatever
//     the caller handed to `prepare()`; the caller is inside the trusted side.
//   · It does NOT defend against a malicious same-process plugin or host that tampers with
//     module state, monkey-patches the returned authorizer, calls the replay claimer directly,
//     or writes the SQLite file itself. Everything here is in-process and inherits the
//     process boundary. A compromised host is out of scope.
//   · It does NOT authenticate the calling process, the QQ account, or the transport.
//   · There is NO production consumer. This module is composed only when a test or an
//     explicitly internal caller passes `operationAuthorization` to the runtime.
//   · Tickets are unforgeable only in the WeakMap sense: copying the object yields a different
//     identity, and a copy carries no capability. No HMAC, no signing key, no unbounded
//     issuance registry is involved, and none is implied.
//   · Every refusal is a fixed value (`false`, `null`, or `{ ok: false, reason }`). Nothing
//     derived from the input, the host, or the store is echoed back.
//
// WHAT `claim()` DOES NOT DO
// --------------------------
//   · It does not roll back or retry. A throwing `store.update` propagates to the caller; a
//     refusal is returned as-is. There is no "try again later" path, because a caller that
//     catches a refusal and retries has simply asked twice.
//   · It does not auto-initialize the replay collection. An uninitialized collection refuses
//     with `REPLAY_REFUSAL.UNINITIALIZED`; initialization is the host's explicit decision.
//   · It does not delete the B2 key on `finish()`. A finished ticket stops verifying, but the
//     durable claim stays exactly as long as B2 says it must.

import { createHash, randomUUID } from 'node:crypto';

import { validateQzoneMcpInput } from './qzone-mcp-contract.mjs';
import { isOriginLedgerConsumption } from './qzone-origin-ledger-offline.mjs';
import { createReplayClaimer, REPLAY_REFUSAL } from './qzone-replay-claim-offline.mjs';

/** How long an approved operation stays executable. */
const OPERATION_TTL_MS = 30000;
/**
 * How long the host may take to answer. Deliberately the same 30s: an approval that arrives
 * after the operation itself expired would mint a ticket that cannot be used, and a hung host
 * must not hold the dispatch open indefinitely.
 */
const APPROVAL_TIMEOUT_MS = 30000;
/** Recursion cap for the canonical snapshot. Real tool inputs are two levels deep. */
const MAX_DEPTH = 32;
/** Same charset the runtime already enforces on `sourceEpoch`. */
const EPOCH_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** The exact request frame. Extra keys are refused rather than ignored. */
const REQUEST_KEYS = Object.freeze(['action', 'input', 'consumption', 'connectionEpoch']);

const refusal = (reason) => Object.freeze({ ok: false, reason });
const ALLOW = Object.freeze({ ok: true });
/**
 * Reason for "this object is not a ticket this factory minted, or the operation it was minted
 * for is no longer the one being asked about".
 *
 * Deliberately a FIXED string with no reference value: the caller learns only that its
 * authorization did not hold, never which field differed, whether a ticket exists, or whether
 * the difference was the input, the action, the epoch or the expiry. Replay-store refusals
 * (`replay`, `uninitialized`, `collection-lost`, ...) are passed through unchanged instead,
 * because those are the durable claim's own vocabulary and the caller already knows it holds
 * that store.
 */
const NOT_AUTHORIZED = 'not-authorized';

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Read a frame of exactly `keys` own DATA properties.
 *
 * Accessors, extra keys, missing keys, and exotic prototypes all return `null`: the frame is
 * caller-supplied data, and a value that needs a getter to be read is not data this module is
 * willing to bind. A hostile Proxy makes `getPrototypeOf`/`ownKeys` throw, which the callers
 * turn into a refusal.
 */
function readFrame(value, keys) {
  try {
    if (!isPlainObject(value)) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length) return null;
    const out = {};
    for (const key of own) {
      if (typeof key !== 'string' || !keys.includes(key)) return null;
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      out[key] = descriptor.value;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Deterministic serialization of a JSON-ish value.
 *
 * Object keys are sorted, array order is preserved, and every shape that JSON.stringify would
 * handle by SILENTLY DROPPING OR COERCING something is REFUSED instead:
 *
 *   · `undefined`, functions, symbols, bigints          -> throw (not "omitted")
 *   · `NaN` / `Infinity` / `-Infinity`                   -> throw (not "null")
 *   · `-0`                                               -> throw (`0` and `-0` are distinct JS
 *                                                            values but one JSON number, so
 *                                                            accepting it would make two
 *                                                            different inputs compare equal)
 *   · accessor properties                                -> throw (reading it would run code)
 *   · non-enumerable own properties                      -> throw (not "skipped")
 *   · non-plain objects (Date, Map, class instances)     -> throw (not "toJSON"ed)
 *   · sparse arrays and arrays with extra own properties -> throw (not "null"-padded)
 *   · cyclic graphs                                      -> throw
 *
 * A shared (non-cyclic) sub-object appearing twice is fine: it serializes twice, identically.
 */
function serialize(value, depth, stack) {
  if (depth > MAX_DEPTH) throw new TypeError('value is too deep');
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    if (Object.is(value, -0)) throw new TypeError('negative zero');
    return JSON.stringify(value);
  }
  if (type !== 'object') throw new TypeError('unsupported value type');
  if (stack.has(value)) throw new TypeError('cyclic value');
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const indices = [];
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') throw new TypeError('symbol key');
        // `length` is the one non-enumerable own property every array has.
        if (key === 'length') continue;
        if (!/^(?:0|[1-9][0-9]*)$/.test(key)) throw new TypeError('unexpected array property');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
          throw new TypeError('unsupported array entry');
        }
        indices.push(Number(key));
      }
      indices.sort((left, right) => left - right);
      const parts = [];
      for (let index = 0; index < indices.length; index += 1) {
        if (indices[index] !== index) throw new TypeError('sparse array');
        parts.push(serialize(value[index], depth + 1, stack));
      }
      return `[${parts.join(',')}]`;
    }
    if (!isPlainObject(value)) throw new TypeError('non-plain object');
    const names = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('symbol key');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw new TypeError('unsupported property');
      }
      names.push(key);
    }
    // Default sort = UTF-16 code unit order: deterministic, locale-independent.
    names.sort();
    const parts = [];
    for (const name of names) {
      parts.push(`${JSON.stringify(name)}:${serialize(value[name], depth + 1, stack)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

/** Canonical text for a value. Throws (never silently normalizes) on an unsupported shape. */
const canonicalize = (value) => serialize(value, 0, new Set());

/** Deep-freeze a JSON-parsed structure. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * The ONLY export: build an authorizer bound to one store, one account and one source epoch.
 *
 * @param {object} options
 * @param {{read: Function, update: Function}} options.store  B2 replay store (host-initialized)
 * @param {number} options.accountId                          positive safe integer (botQq)
 * @param {string} options.sourceEpoch                        non-empty epoch string
 * @param {() => number} options.clock                        trusted clock, integer ms
 * @param {(operation: object) => unknown} options.approveOperation host verdict (strict `true`)
 * @param {(operation: object, consumption: object) => unknown} options.isCurrent
 *   must return strict `true`; anything else (including a thenable) is "not current"
 */
export function createQzoneOperationAuthorizer({ store, accountId, sourceEpoch, clock, approveOperation, isCurrent } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('operation authorizer needs a store with read/update');
  }
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new TypeError('operation authorizer needs a positive accountId (botQq)');
  }
  if (typeof sourceEpoch !== 'string' || !EPOCH_RE.test(sourceEpoch)) {
    throw new TypeError('operation authorizer needs a valid sourceEpoch');
  }
  if (typeof clock !== 'function') throw new TypeError('operation authorizer needs a clock function');
  if (typeof approveOperation !== 'function') {
    throw new TypeError('operation authorizer needs an approveOperation function');
  }
  if (typeof isCurrent !== 'function') throw new TypeError('operation authorizer needs an isCurrent function');

  // The ONLY way to tell a genuine ticket from a structurally identical copy. Private to this
  // factory: no other module, no caller, and no serialization path can write into it.
  /** ticket -> { operation, consumption, canonicalInput, closed, claimed } */
  const issued = new WeakMap();

  const claimer = createReplayClaimer({ store, accountId });

  /** Trusted clock read. Throws on a non-integer; callers turn that into a refusal. */
  function readClock() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid clock');
    return value;
  }

  /**
   * Strictly-true policy check. A thenable can never be `true`; its settlement is observed so a
   * mistaken async `isCurrent` cannot escape as an unhandled rejection.
   */
  function isStrictlyCurrent(operation, consumption) {
    try {
      const verdict = isCurrent(operation, consumption);
      if (verdict === true) return true;
      if (verdict !== null && (typeof verdict === 'object' || typeof verdict === 'function')) {
        const then = verdict.then;
        if (typeof then === 'function') {
          try { then.call(verdict, () => {}, () => {}); } catch {}
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Everything that must hold both before and after the host verdict: genuine branded
   * consumption, the constructor's source epoch, unexpired operation, and a strictly current
   * source. `consumption` is compared against the fields captured in `operation`, so a
   * consumption that changed underneath the ticket is refused.
   */
  function isLive(operation, consumption, now) {
    try {
      // The authorization is valid strictly before its expiration time.
      if (!Number.isSafeInteger(operation.expiresAt) || now >= operation.expiresAt) return false;
      if (!isOriginLedgerConsumption(consumption)) return false;
      if (consumption.epoch !== sourceEpoch) return false;
      if (consumption.sessionId !== operation.sessionId) return false;
      if (consumption.requestId !== operation.requestId) return false;
      if (consumption.callId !== operation.callId) return false;
      if (consumption.origin !== operation.origin) return false;
      return isStrictlyCurrent(operation, consumption);
    } catch {
      return false;
    }
  }

  /**
   * Ask the host and wait at most `APPROVAL_TIMEOUT_MS`.
   *
   * Returns `true` only for a strict `true`. A refusal, a throw, a rejection, a truthy
   * look-alike (`1`, `'true'`, `undefined`) and a timeout are all `false`. The timer is always
   * cleared, and the host's promise always has handlers attached, so a late settlement is
   * observed and can neither mint a ticket nor become an unhandled rejection.
   */
  async function askHost(operation) {
    let pending;
    try {
      const verdict = approveOperation(operation);
      if (verdict === true) return true;
      if (verdict === null || (typeof verdict !== 'object' && typeof verdict !== 'function')) return false;
      pending = Promise.resolve(verdict);
    } catch {
      return false;
    }
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), APPROVAL_TIMEOUT_MS);
    });
    try {
      const verdict = await Promise.race([
        pending.then((value) => value === true, () => false),
        timeout,
      ]);
      return verdict === true;
    } catch {
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * Build the frozen operation and ask the host. Resolves to an opaque ticket, or `null`.
   *
   * Never throws: every refusal, throw, rejection and invalid clock collapses to `null`.
   * The caller's `input` is snapshotted and frozen BEFORE the host sees it, so the host
   * inspects exactly what would execute and later caller mutation is irrelevant.
   */
  async function prepare(request) {
    try {
      const frame = readFrame(request, REQUEST_KEYS);
      if (!frame) return null;
      const { action, input, consumption, connectionEpoch } = frame;

      if (typeof action !== 'string' || !action) return null;
      // Stored as given: neither rounded nor re-derived. `isCurrent` in the runtime compares
      // the LIVE connection epoch with this exact value.
      if (!Number.isSafeInteger(connectionEpoch) || connectionEpoch < 0) return null;
      if (!isOriginLedgerConsumption(consumption)) return null;
      if (consumption.epoch !== sourceEpoch) return null;

      // Identity comes from the branded consumption ONLY. A self-reported session/request/
      // call id is not part of the request frame, so it cannot be injected.
      const sessionId = consumption.sessionId;
      const requestId = consumption.requestId;
      const callId = consumption.callId;
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) return null;
      if (typeof requestId !== 'string' || !requestId || requestId.length > 128) return null;
      if (typeof callId !== 'string' || !callId || callId.length > 128) return null;
      const origin = consumption.origin;

      if (!validateQzoneMcpInput(action, input)) return null;

      const canonicalInput = canonicalize(input);
      const inputDigest = createHash('sha256').update(canonicalInput, 'utf8').digest('hex');
      // The snapshot is produced FROM the canonical text, so there is exactly one
      // representation: the digest, the frozen input, and every later comparison all describe
      // the same bytes.
      const snapshot = deepFreeze(JSON.parse(canonicalInput));

      const issuedAt = readClock();
      const operation = Object.freeze({
        accountId,
        sessionId,
        requestId,
        callId,
        sourceEpoch,
        connectionEpoch,
        origin,
        action,
        input: snapshot,
        inputDigest,
        authorizationId: randomUUID(),
        expiresAt: issuedAt + OPERATION_TTL_MS,
      });

      // Before: the host must not even be asked about an operation that is already stale.
      if (!isLive(operation, consumption, issuedAt)) return null;

      if (!(await askHost(operation))) return null;

      // After: the host may have taken time, and the world may have moved. Re-check the same
      // facts on a fresh clock read so approval cannot launder a revoked source.
      const confirmedAt = readClock();
      if (!isLive(operation, consumption, confirmedAt)) return null;

      const ticket = Object.freeze({ operation });
      issued.set(ticket, { operation, consumption, canonicalInput, closed: false, claimed: false });
      return ticket;
    } catch {
      return null;
    }
  }

  /**
   * Is `expected` still exactly the operation this ticket was approved for?
   *
   * Compares the action, the FULL canonical input, the exact consumption reference, the
   * connection epoch, the expiry, and the live source. Returns `false` on any mismatch and
   * never throws, never mutates the operation, and never touches the store.
   */
  function verify(ticket, expected) {
    try {
      const record = issued.get(ticket);
      if (!record || record.closed !== false) return false;
      const frame = readFrame(expected, REQUEST_KEYS);
      if (!frame) return false;
      const { action, input, consumption, connectionEpoch } = frame;
      const operation = record.operation;
      if (action !== operation.action) return false;
      if (connectionEpoch !== operation.connectionEpoch) return false;
      // Reference identity, not field equality: a different consumption object — even one
      // describing the same quadruple — is a different authorization basis.
      if (consumption !== record.consumption) return false;
      let canonicalInput;
      try {
        canonicalInput = canonicalize(input);
      } catch {
        return false;
      }
      if (canonicalInput !== record.canonicalInput) return false;
      return isLive(operation, record.consumption, readClock());
    } catch {
      return false;
    }
  }

  /**
   * May the caller send? Verifies first, then takes the durable B2 key exactly once.
   *
   * `{ ok: true }` is the only allow. The SECOND claim of a still-valid ticket also returns
   * `{ ok: true }` without another `store.update`: that is what lets one logical read make
   * several platform calls. Any other outcome is a refusal, and a throwing store propagates
   * to the caller (a throw is never turned into an allow, and nothing is rolled back).
   */
  function claim(ticket, expected) {
    if (!verify(ticket, expected)) return refusal(NOT_AUTHORIZED);
    const record = issued.get(ticket);
    if (!record) return refusal(NOT_AUTHORIZED);
    if (record.claimed === true) return ALLOW;
    const operation = record.operation;
    // An unusable clock is a refusal, not a crash: unlike a failing STORE (which must
    // propagate so the caller never mistakes a broken transaction for an allow), a clock that
    // cannot be read simply means "this claim cannot be stamped", and B2 already has the exact
    // reason code for that. Nothing is written.
    let now;
    try {
      now = readClock();
    } catch {
      return refusal(REPLAY_REFUSAL.INVALID_CLOCK);
    }
    // Synchronous, single `store.update`: two racing claims cannot both win. The identity is
    // the quadruple; `generation` is diagnostic only (B2 never decides on it). NOT wrapped in
    // try/catch on purpose: a store failure must reach the caller.
    const outcome = claimer.claim({
      sessionId: operation.sessionId,
      requestId: operation.requestId,
      callId: operation.callId,
      generation: operation.connectionEpoch,
    }, { now });
    if (!outcome || outcome.ok !== true) {
      return refusal(typeof outcome?.reason === 'string' ? outcome.reason : REPLAY_REFUSAL.INVALID_CLOCK);
    }
    record.claimed = true;
    return ALLOW;
  }

  /**
   * Retire the ticket. Subsequent `verify`/`claim` with it fail, a second `finish` is a
   * no-op, and an unknown/forged ticket is ignored rather than throwing.
   *
   * Deliberately does NOT delete the B2 claim: the durable "this quadruple was used" fact
   * outlives the process-local ticket.
   */
  function finish(ticket) {
    try {
      const record = issued.get(ticket);
      if (record === undefined) return undefined;
      record.closed = true;
      issued.delete(ticket);
    } catch {
      // A hostile ticket key cannot make finish throw.
    }
    return undefined;
  }

  return Object.freeze({ prepare, verify, claim, finish });
}
