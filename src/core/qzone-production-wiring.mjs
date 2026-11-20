// Production wiring for QZone: the approval sink and the runtime assembly, in ONE place.
//
// WHY THIS MODULE EXISTS
// ----------------------
// The pieces already exist and are tested separately:
//   · `createQzoneWriteAudit`             (qzone-write-audit-offline.mjs)        — the durable sink;
//   · `createQzoneApprovalAuditRecorder`  (qzone-write-audit-broker-adapter-offline.mjs) — decision -> row;
//   · `createQzoneOperationApprovalBroker`(qzone-operation-approval-console.mjs)— the pending queue;
//   · `createQzoneRuntime`                (qzone-runtime-wiring.mjs)             — the dispatch root.
// Nothing in this repository composes them for production. This module is that composition and
// nothing else: it takes every dependency as an ARGUMENT and returns frozen handles.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
// -----------------------------------------
//   · It never reads config.json, .credentials.yaml, ACLs, state/*.sqlite or any other file.
//   · It never opens a network connection and never talks to SnowLuma/OneBot. Every transport
//     (`call`, `writeWiring.send`) is injected by the caller.
//   · It never decides that WRITES ARE ON. Only an explicit `writeWiring` gives the runtime a write
//     capability; without it the runtime keeps its pre-existing `write-not-wired` refusal (and, for
//     `publish`, the older `origin-unverified` — see qzone-runtime-wiring.mjs:593-616). An `audit`
//     sink on its own adds NO capability and writes NO row: it is accepted so the approval broker and
//     the write path can share one sink, and it stays inert until a `writeWiring` carries it.
//   · It creates no default store, clock, transport, audit sink or approval policy. A missing or
//     mistyped dependency is a `TypeError`, never a substituted default: a default here would be a
//     silent policy decision (e.g. "writes are fine"), which is exactly what this wiring must not make.
//
// ⚠️ THE APPROVAL INVARIANT, AND WHAT "STRICT true" MEANS
// ------------------------------------------------------
// `createQzoneOperationApprovalBroker(...).decide()` releases an approval ONLY when its injected
// `recordDecision` answers strict `true`; anything else (false, a thrown error, a thenable) closes the
// ticket as NOT approved (qzone-operation-approval-console.mjs:76-82). The broker already listens for
// a thenable, but a synchronous composition should never hand it one: an approval path that can be
// "resolved later" has no single point at which the decision is known, and a caller can read the
// returned `false` while a promise silently settles `true` behind it.
// `createQzoneStrictDecisionRecorder` therefore NORMALISES the answer: only a synchronous `true` is
// an approval, every other answer (including `Promise.resolve(true)`) becomes `false` and its
// settlement is observed so it cannot surface as an unhandled rejection. The broker then closes the
// ticket, which is the only fail-closed reading of "the decision could not be recorded".
//
// ⚠️ WHAT THE APPROVAL ROW CAN AND CANNOT PROVE — do not widen these claims
// ------------------------------------------------------------------------
// The row records WHO (the console session id passed to `decide`, from a server-verified session)
// decided WHAT (approved/rejected) for WHICH operation (the quadruple digest shared with the write
// path's intent/result rows). It is NOT proof that a human was present, that the operation described
// is the one a model proposed (the host's `approveOperation` decides that), or that a platform
// request was ever issued. The sink validates shape, not truth (qzone-write-audit-offline.mjs header).
//
// TEARDOWN
// --------
// This assembly creates exactly one thing the caller cannot otherwise reach: nothing that owns a
// handle. `createQzoneRuntime` exposes no dispose and this module will not invent one, so `teardown`
// is idempotent bookkeeping: it marks THIS assembly as torn down and reports whether that was the
// first call. It never closes the store, the broker, the ledger or any transport — those belong to
// the caller (call `broker.close()` on the broker returned by
// `createQzoneProductionApprovalBroker` when the console shuts down).
import { createQzoneOperationApprovalBroker } from './qzone-operation-approval-console.mjs';
import { createQzoneRuntime } from './qzone-runtime-wiring.mjs';
import { createQzoneWriteAudit } from './qzone-write-audit-offline.mjs';
import { createQzoneApprovalAuditRecorder } from './qzone-write-audit-broker-adapter-offline.mjs';

/** Every option `createQzoneProductionApprovalBroker` accepts. Anything else is a TypeError. */
const APPROVAL_KEYS = Object.freeze(['store', 'clock', 'capacity']);

/** The injected dependencies of `createQzoneProductionRuntime`; every one is read from the caller. */
const RUNTIME_KEYS = Object.freeze([
  'store', 'botQq', 'sourceEpoch', 'authorizeSource', 'getConnectionEpoch', 'call',
  'getBridgeSessions', 'clock', 'mode',
  'writeWiring', 'exceptionReads', 'operationAuthorization', 'audit',
]);

/** The required injections that MUST be functions. */
const RUNTIME_FUNCTION_KEYS = Object.freeze([
  'authorizeSource', 'getConnectionEpoch', 'call', 'getBridgeSessions', 'clock',
]);

/** The modes the runtime accepts (qzone-runtime-wiring.mjs:76). Anything else is refused here too. */
const MODES = new Set(['disabled', 'read-only', 'enabled']);

/** The id charset `sourceEpoch` must satisfy (the runtime's own `CTX_ID`). */
const EPOCH = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Copy the caller's OWN DATA properties and refuse everything else.
 *
 * Two things are deliberate here:
 *   · an UNKNOWN key is a TypeError, not a silently ignored typo — a misspelt `writeWirring` must not
 *     look like "writes were wired" while the runtime keeps refusing them;
 *   · an ACCESSOR is a TypeError too, because reading it here would run caller code once and then pin
 *     whatever it returned, which is not what "the dependency I passed" means.
 */
function readClosedOptions(value, allowed, message) {
  const copy = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new TypeError(message);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError(message);
    copy[key] = descriptor.value;
  }
  return copy;
}

/**
 * Build the approval broker AND the sink its decisions are recorded in.
 *
 * The three modules are wired exactly the way their own headers describe — sink -> recorder -> broker
 * — so the `approval` row lands in `state.writeAudit` before the ticket is released. Nothing here
 * creates a second audit trail: the returned `audit` is the same sink the write path must be given
 * (through `writeWiring.audit` or the runtime assembly's `audit` option) for the three rows of one
 * authorisation to share an `authorizationId`.
 *
 * @param {object} options
 * @param {{read: Function, update: Function}} options.store  the offline store; its `state.writeAudit`
 *   array is the sink. The handle is used verbatim — no wrapper is minted here.
 * @param {() => number} options.clock  trusted clock, integer milliseconds. Used for `decidedAt`.
 * @param {number} [options.capacity]  pending-ticket cap, 1..1024 (the broker's own default is 64).
 * @returns a frozen `{ broker, audit, recordDecision }`.
 * @throws {TypeError} on any missing, mistyped or unknown dependency. No default is invented.
 */
export function createQzoneProductionApprovalBroker(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('invalid production approval broker options');
  }
  const supplied = readClosedOptions(options, APPROVAL_KEYS, 'invalid production approval broker options');
  const { store } = supplied;
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('production approval broker needs a store with read/update');
  }
  if (typeof supplied.clock !== 'function') {
    throw new TypeError('production approval broker needs a clock function');
  }
  const { clock } = supplied;
  let capacity;
  // An EXPLICIT `undefined` is the caller omitting it, exactly as the runtime treats an absent
  // option elsewhere in this repository. Any other non-integer is refused rather than coerced.
  if (supplied.capacity !== undefined) {
    capacity = supplied.capacity;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024) {
      throw new TypeError('invalid production approval broker capacity');
    }
  }
  const audit = createQzoneWriteAudit({ store });
  const recorder = createQzoneApprovalAuditRecorder({ audit, clock });
  const recordDecision = createQzoneStrictDecisionRecorder(recorder);
  const broker = createQzoneOperationApprovalBroker(
    capacity === undefined ? { clock, recordDecision } : { clock, capacity, recordDecision },
  );
  return Object.freeze({ broker, audit, recordDecision });
}

/**
 * Normalise a decision recorder's answer to a SYNCHRONOUS boolean.
 *
 * WHY NOT PASS THE RECORDER THROUGH DIRECTLY: the broker accepts strict `true` only and closes the
 * ticket otherwise, but it must also stay possible to read the outcome of `decide()` as one value.
 * If a recorder ever answered a thenable, `decide()` would be `false` while the promise settled
 * `true` in the background — the approval would exist in one place and not in the other. This
 * wrapper removes that ambiguity structurally: `true` stays `true`; `false`, a throw, `null`,
 * `1`, `'true'`, `undefined` and every thenable become `false`.
 *
 * An observed thenable is given no-op handlers so a rejection cannot escape as an unhandled
 * rejection after the ticket has already been closed.
 *
 * @param {(decision: object) => unknown} recorder  the raw recorder (e.g.
 *   `createQzoneApprovalAuditRecorder`'s product).
 * @returns `(decision) => boolean`.
 */
export function createQzoneStrictDecisionRecorder(recorder) {
  if (typeof recorder !== 'function') throw new TypeError('strict decision recorder needs a function');
  return function recordDecision(decision) {
    let recorded;
    try {
      recorded = recorder(decision);
    } catch {
      return false;
    }
    if (recorded === true) return true;
    if (recorded !== false) {
      try {
        const then = recorded !== null && (typeof recorded === 'object' || typeof recorded === 'function')
          ? recorded.then
          : undefined;
        if (typeof then === 'function') then.call(recorded, () => {}, () => {});
      } catch { /* an unruly thenable is still just a non-approval */ }
    }
    return false;
  };
}

/**
 * Assemble the production runtime from EXPLICITLY injected dependencies.
 *
 * Every dependency the runtime needs is taken from `options` and forwarded verbatim; this function
 * adds no default, reads no configuration and performs no I/O. The only transformation it makes is
 * the audit hand-off described below, and it can only ever move an already-supplied sink.
 *
 * THE AUDIT HAND-OFF: `createQzoneRuntime` does not accept a top-level `audit`; the sink belongs
 * inside `writeWiring` (`WRITE_WIRING_KEYS`, qzone-runtime-wiring.mjs:81). So when BOTH a
 * `writeWiring` and an `audit` are supplied, this assembly puts the sink into the wiring. If the
 * wiring already names a DIFFERENT sink the call is refused instead of silently picking one: two
 * sinks mean the intent/result rows and the approval rows would land in different trails while
 * looking correlated.
 *
 * WRITE CAPABILITY IS NEVER ADDED HERE: no `writeWiring` means no write wiring is forwarded, and the
 * runtime's `write-not-wired` refusal is untouched. An incomplete `writeWiring` is forwarded as the
 * caller wrote it, so the runtime's own `write-wiring-incomplete` refusal stays where it was.
 *
 * @param {object} options
 * @param {{read: Function, update: Function}} options.store
 * @param {number} options.botQq                positive safe integer (the bot's QQ).
 * @param {string} options.sourceEpoch          the host's source generation id.
 * @param {(consumption: object) => unknown} options.authorizeSource
 * @param {() => number} options.getConnectionEpoch
 * @param {(action: string, params?: object) => Promise<unknown>} options.call  the read transport.
 * @param {(sessionId: string) => object | null} options.getBridgeSessions
 * @param {() => number} options.clock
 * @param {'disabled'|'read-only'|'enabled'} options.mode
 * @param {object} [options.writeWiring]        forwarded verbatim; the ONLY way to get writes.
 * @param {object} [options.exceptionReads]     forwarded verbatim (the runtime snapshots it).
 * @param {object} [options.operationAuthorization] forwarded verbatim (host approval + replay store).
 * @param {{recordWrite: Function}} [options.audit] the write-audit sink; inert without writeWiring.
 * @returns a frozen `{ runtime, teardown }`.
 * @throws {TypeError} on any missing, mistyped or unknown dependency. No default is invented.
 */
export function createQzoneProductionRuntime(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('invalid production runtime options');
  }
  const supplied = readClosedOptions(options, RUNTIME_KEYS, 'invalid production runtime options');
  for (const key of ['store', 'botQq', 'sourceEpoch', 'mode', ...RUNTIME_FUNCTION_KEYS]) {
    if (!Object.hasOwn(supplied, key)) {
      throw new TypeError(`production runtime is missing a required dependency: ${key}`);
    }
  }
  const { store } = supplied;
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('production runtime needs a store with read/update');
  }
  if (!Number.isSafeInteger(supplied.botQq) || supplied.botQq <= 0) {
    throw new TypeError('production runtime needs a positive botQq');
  }
  if (typeof supplied.sourceEpoch !== 'string' || !EPOCH.test(supplied.sourceEpoch)) {
    throw new TypeError('production runtime needs a valid sourceEpoch');
  }
  for (const key of RUNTIME_FUNCTION_KEYS) {
    if (typeof supplied[key] !== 'function') {
      throw new TypeError(`production runtime needs a ${key} function`);
    }
  }
  if (typeof supplied.mode !== 'string' || !MODES.has(supplied.mode)) {
    throw new TypeError('production runtime needs a valid mode');
  }

  const writeWiring = supplied.writeWiring;
  if (writeWiring !== undefined && (writeWiring === null || typeof writeWiring !== 'object' || Array.isArray(writeWiring))) {
    throw new TypeError('invalid write wiring dependencies');
  }
  const audit = supplied.audit;
  if (audit !== undefined && (audit === null || typeof audit !== 'object' || typeof audit.recordWrite !== 'function')) {
    throw new TypeError('production runtime needs an audit sink with recordWrite');
  }

  let wiring = writeWiring;
  if (audit !== undefined && writeWiring !== undefined) {
    const descriptor = Object.getOwnPropertyDescriptor(writeWiring, 'audit');
    if (descriptor && !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('invalid write wiring dependencies');
    }
    const wiringAudit = descriptor?.value;
    if (wiringAudit !== undefined && wiringAudit !== audit) {
      throw new TypeError('production runtime got two different audit sinks');
    }
    if (wiringAudit === undefined) {
      // Copy the caller's OWN DATA properties into a NEW object. A symbol key is refused rather than
      // dropped: without the merge it would reach `createQzoneRuntime` and be refused there, and a
      // silent difference between the two paths is exactly what this assembly must not introduce.
      // Unknown STRING keys are copied through unchanged, so the runtime's own closed-key refusal
      // (`WRITE_WIRING_KEYS`, qzone-runtime-wiring.mjs:239-245) still speaks for them.
      const names = Reflect.ownKeys(writeWiring);
      if (names.some((key) => typeof key !== 'string')) {
        throw new TypeError('invalid write wiring dependencies');
      }
      const merged = readClosedOptions(writeWiring, names, 'invalid write wiring dependencies');
      merged.audit = audit;
      wiring = Object.freeze(merged);
    }
  }

  const runtimeOptions = {
    store,
    botQq: supplied.botQq,
    sourceEpoch: supplied.sourceEpoch,
    authorizeSource: supplied.authorizeSource,
    getConnectionEpoch: supplied.getConnectionEpoch,
    call: supplied.call,
    getBridgeSessions: supplied.getBridgeSessions,
    clock: supplied.clock,
    mode: supplied.mode,
  };
  if (wiring !== undefined) runtimeOptions.writeWiring = wiring;
  if (supplied.exceptionReads !== undefined) runtimeOptions.exceptionReads = supplied.exceptionReads;
  if (supplied.operationAuthorization !== undefined) {
    runtimeOptions.operationAuthorization = supplied.operationAuthorization;
  }

  const runtime = createQzoneRuntime(runtimeOptions);

  let tornDown = false;
  /**
   * Idempotent bookkeeping for THIS assembly. It closes nothing it did not create (it created no
   * handle), and it never touches the injected store/broker/ledger/transports.
   * @returns `true` on the first call, `false` afterwards.
   */
  function teardown() {
    if (tornDown) return false;
    tornDown = true;
    return true;
  }

  return Object.freeze({ runtime, teardown });
}
