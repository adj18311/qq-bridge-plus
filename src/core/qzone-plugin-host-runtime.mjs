// The PLUGIN-SIDE host runtime assembly: the object a real host hands to
// `createQzonePluginHandle(ctx, config, runtime)` so the qzone-safe plugin reaches
// `enabled-dispatch-ready` over a REAL ledger-backed source.
//
// 本模块做什么 / 不做什么 (short version)
// --------------------------------------
//   · 它把宿主注入的依赖装配成插件需要的 `{ dispatch, epoch, sourceLifetime }`，并额外给出
//     `status()` / `teardown()`；
//   · 它不读 config.json、不读凭据、不开网络、不发任何 OneBot 请求（`call` / `writeWiring.send`
//     全部由调用方注入，本模块自己从不调用它们）；
//   · 它不发明任何默认依赖：缺一个必填注入就是 TypeError，绝不替调用方做策略决定。
//
// WHY THIS MODULE EXISTS
// ----------------------
// `plugins/qzone-safe/index.mjs:40-43` decides readiness from exactly two facts — a
// `dispatch` function and a non-empty `epoch` — and `:195-217` reads the per-session
// origin ledger from an injected `sourceLifetime`. Everything else (creating the ledgers,
// refusing a foreign consumption, wiring the write opt-in, the cross-process approval
// hook) lived only inside tests and probes. This module is that assembly, and nothing
// else: every dependency is an ARGUMENT.
//
// ⚠️ THE TRUST SPLIT — which part of this is a REAL source and which part is only a WIRE
// (Codex ruling #1: a source must not be self-reported)
// ----------------------------------------------------------------------------------
// This module NEVER mints a source from a self-reported field. The three inputs that
// could be forged are handled as follows:
//
//   1. `dispatch(action, input, context)` — `context` is whatever the caller passes; it is
//      NOT authenticated here and it is NOT used to create anything. A dispatch is
//      authorized only when it carries a BRANDED consumption minted by a ledger this module
//      already owns for that session, and the runtime re-checks session/call ids against it
//      (`qzone-runtime-wiring.mjs:516-536`). The plugin produces that context from
//      `agent/session` + `exec.callId` (host-provided) and consumes it from the ledger
//      before dispatching (`plugins/qzone-safe/index.mjs:278-295`). Consequence: a caller
//      that invents `{sessionId, callId}` gets `origin-unverified`, never a fresh ledger.
//      There is deliberately NO lazy ledger creation on this path.
//
//   2. `sourceLifetime.getLedger(sessionId)` — this IS the trusted path, and it is the only
//      one that creates a ledger. The plugin calls it from `agent/created` / `ledgerFor` with
//      a session id taken from the HOST's agent object (`plugins/qzone-safe/index.mjs:195-208,
//      :427`). Creating lazily there is what makes "same session, same ledger" hold for the
//      whole session, and therefore what keeps the ledger's replay protection: `spentCalls`
//      and `usedRequests` are per ledger, so a per-dispatch ledger would clear them.
//
//   3. `authorizeSource(consumption)` — it forwards to the owning ledger's
//      `ownsConsumption`, so a consumption branded by a DIFFERENT ledger object (a foreign
//      session, or a ledger this runtime already invalidated) is refused. It is never a
//      constant `true`, and a session this module does not already hold a ledger for is
//      refused rather than given one.
//
// WHAT PRODUCTION STILL LACKS (stated here, not implied elsewhere)
// ---------------------------------------------------------------
// This module assembles; it does not authenticate. To turn it into a real source the host
// still has to supply, OUTSIDE this file:
//   · `call`             — a real OneBot transport (nothing here opens a connection);
//   · `approveOperation` — the host's APPROVAL POLICY. It may be the cross-process channel's
//     client, or a policy that always approves (`host-assembly.mjs` installs that one when no
//     channel is configured — the operator's C14 ruling that no human sign-off is needed). What
//     this module requires is that SOME policy is supplied, never that a human is asked.
//     `replayStore` must additionally be initialized by the host (`initializeReplayState`) or
//     every approved operation refuses `uninitialized` — B2 is NOT part of the approval and
//     stays required in every configuration;
//   · `getConnectionEpoch` — the host's own connection generation;
//   · the bridge-request / pre-step / tool-call feed into the ledger
//     (`registerBridgeRequest` / `observeStep` / `observeToolCall`), which is what turns a
//     real inbound QQ message plus a real host tool call into a consumable position.
// None of those is created here, and no in-process object can substitute for them.
//
// FAIL CLOSED — the three closed doors
// -----------------------------------
//   · no `writeWiring`  ⇒ every write keeps the runtime's own refusal: `write-not-wired`
//     for comment/reply/like, and the earlier `origin-unverified` for `publish` (which
//     carries no single `target_uin`, so the binding mint runs first).
//   · `mode` omitted    ⇒ `'read-only'`. A closed default, not a policy decision: it can
//     only take capability away. Writes then refuse `write-not-enabled` even with a
//     complete wiring, and `status().mode` says so.
//   · bad/missing dep   ⇒ TypeError at construction. A mistyped key (`writeWirring`) is
//     refused rather than ignored, because ignoring it would look like "writes were wired"
//     while the runtime kept refusing them.
//
// ⚠️ status() IS PURE, ON PURPOSE
// ------------------------------
// `status()` reports only facts THIS module owns (whether a wiring was supplied and whether
// it is structurally complete, how many ledgers exist, the source epoch, the mode). It
// deliberately does NOT call the runtime's own `status()`: that call reads the connection
// epoch and latches a PERMANENT invalidation when the read throws
// (`qzone-runtime-wiring.mjs:262-280`). A monitoring probe must not be able to kill a
// healthy runtime, so the runtime's liveness view stays with the host.
//
// TEARDOWN
// --------
// `teardown()` is idempotent bookkeeping plus ONE real effect: every ledger this module
// created is `disconnect()`ed (a one-way latch — those sessions can never consume again)
// and dropped, so `sourceEpoch()` becomes `null` and the plugin purges its cache. It never
// closes the injected store, clock, transports or replay store: those belong to the caller.
import { createQzoneOriginLedger, isOriginLedgerConsumption } from './qzone-origin-ledger-offline.mjs';
import { createQzoneRuntime } from './qzone-runtime-wiring.mjs';

/** Every option this assembly accepts. Anything else is a TypeError (a typo must not pass). */
const OPTION_KEYS = Object.freeze([
  'store', 'botQq', 'sourceEpoch', 'clock', 'call', 'getConnectionEpoch',
  'approveOperation', 'replayStore', 'writeWiring', 'mode', 'sessionLimit', 'trackingLimit',
]);

/** The injections that have no closed default: absent ⇒ TypeError, never substituted. */
const REQUIRED_KEYS = Object.freeze([
  'store', 'botQq', 'sourceEpoch', 'clock', 'call',
  'getConnectionEpoch', 'approveOperation', 'replayStore',
]);

/** The runtime's own source-epoch charset (`CTX_ID`, qzone-runtime-wiring.mjs:79). */
const EPOCH = /^[A-Za-z0-9_.:-]{1,128}$/;
/** The ledger's own session-id charset (qzone-origin-ledger-offline.mjs:13). */
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** The runtime's mode vocabulary (qzone-runtime-wiring.mjs:76). */
const MODES = new Set(['disabled', 'read-only', 'enabled']);
/**
 * The CLOSED mode used when the caller does not name one.
 *
 * It is 'read-only' rather than 'enabled' because a default may only ever REMOVE capability
 * here: with 'enabled' an omitted option would silently arm the write path of a caller that
 * never asked for it. Writes then refuse `write-not-enabled` (qzone-runtime-wiring.mjs:621),
 * and `status().mode` reports the value that is in force.
 */
const DEFAULT_MODE = 'read-only';
/** Mirrors `qzone-source-lifetime-offline.mjs:14` so a hostile session-id stream stays bounded. */
const DEFAULT_SESSION_LIMIT = 256;
/** Mirrors the ledger's own default and the runtime's `trackingLimit` default. */
const DEFAULT_TRACKING_LIMIT = 4096;
/**
 * Reporting mirrors of two CLOSED sets owned by `qzone-runtime-wiring.mjs`
 * (`WRITE_SOURCES` :88, `WRITE_TOOLS` :78). They are used ONLY to describe a wiring in
 * `status()`; they grant nothing. If that module ever widens a set, the worst outcome here
 * is a report that says `incomplete` about a wiring the runtime would accept — a false
 * NEGATIVE in telemetry, never a false capability.
 */
const WRITE_SOURCES = new Set(['qq', 'patrol']);
const WRITE_TOOLS = new Set(['publish', 'comment', 'reply', 'like']);

/**
 * Copy the caller's OWN DATA properties and refuse everything else.
 *
 * Same rule as `qzone-production-wiring.mjs:91-100` (which does not export it, so it is
 * restated here rather than imported): an unknown key is a TypeError, and so is an accessor —
 * reading one would run caller code once and pin whatever it returned, which is not what
 * "the dependency I passed" means.
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

/** Read one own DATA property without running a getter or touching a prototype. */
function ownValue(target, key) {
  try {
    return Object.getOwnPropertyDescriptor(target, key)?.value;
  } catch {
    return undefined;
  }
}

/**
 * Assemble the plugin-side host runtime.
 *
 * @param {object} options
 * @param {{read: Function, update: Function}} options.store  the durable state store.
 * @param {number} options.botQq                              positive safe integer.
 * @param {string} options.sourceEpoch                        the host's source generation id.
 * @param {() => number} options.clock                        trusted clock (integer ms).
 * @param {(action: string, params?: object) => Promise<unknown>} options.call
 *   the read transport. INJECTED and never called from here.
 * @param {() => number} options.getConnectionEpoch           the host's connection generation.
 * @param {(operation: object) => unknown} options.approveOperation
 *   the host's APPROVAL POLICY, same signature as the broker's
 *   (`qzone-operation-approval-console.mjs:40`): it is asked for EVERY host-approved
 *   operation, reads included, and only a strict `true` (or a promise settling `true`)
 *   releases it.
 *
 *   STILL REQUIRED, AND DELIBERATELY SO (C14): the operator ruled that no human sign-off is
 *   needed, and that ruling is expressed by the CALLER as a policy function — `host-assembly.mjs`
 *   passes `AUTO_APPROVE_POLICY` when no channel is configured. Making this optional here would
 *   be a different change: it would let a caller that FORGOT to supply a policy get one for free,
 *   and "the approval step silently vanished because an argument was missing" is exactly the
 *   shape that should be impossible. Absent ⇒ TypeError, unchanged.
 * @param {{read: Function, update: Function}} options.replayStore
 *   the B2 replay store. Must be initialized by the host, or every write refuses.
 * @param {object} [options.writeWiring]  forwarded VERBATIM; the ONLY way writes open.
 * @param {'disabled'|'read-only'|'enabled'} [options.mode]  default `'read-only'`.
 * @param {number} [options.sessionLimit]  1..4096, default 256.
 * @param {number} [options.trackingLimit] 1..4096, default 4096 (shared with the runtime).
 * @returns a frozen `{ epoch, dispatch, sourceLifetime, status, teardown }`.
 * @throws {TypeError} on any missing, mistyped or unknown dependency. No default is invented.
 */
export function createQzonePluginHostRuntime(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('invalid plugin host runtime options');
  }
  const supplied = readClosedOptions(options, OPTION_KEYS, 'invalid plugin host runtime options');
  for (const key of REQUIRED_KEYS) {
    if (!Object.hasOwn(supplied, key)) {
      throw new TypeError('plugin host runtime is missing a required dependency: ' + key);
    }
  }
  const {
    store, botQq, sourceEpoch, clock, call,
    getConnectionEpoch, approveOperation, replayStore,
  } = supplied;
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('plugin host runtime needs a store with read/update');
  }
  if (!Number.isSafeInteger(botQq) || botQq <= 0) {
    throw new TypeError('plugin host runtime needs a positive botQq');
  }
  if (typeof sourceEpoch !== 'string' || !EPOCH.test(sourceEpoch)) {
    throw new TypeError('plugin host runtime needs a valid sourceEpoch');
  }
  if (typeof clock !== 'function') throw new TypeError('plugin host runtime needs a clock function');
  if (typeof call !== 'function') throw new TypeError('plugin host runtime needs a call function');
  if (typeof getConnectionEpoch !== 'function') {
    throw new TypeError('plugin host runtime needs a getConnectionEpoch function');
  }
  if (typeof approveOperation !== 'function') {
    throw new TypeError('plugin host runtime needs an approveOperation function');
  }
  if (!replayStore || typeof replayStore.read !== 'function' || typeof replayStore.update !== 'function') {
    throw new TypeError('plugin host runtime needs a replayStore with read/update');
  }

  // An EXPLICIT `undefined` is "omitted", exactly as the runtime treats an absent option
  // elsewhere in this repository. Any other value must be one of the closed set.
  const mode = supplied.mode === undefined ? DEFAULT_MODE : supplied.mode;
  if (typeof mode !== 'string' || !MODES.has(mode)) {
    throw new TypeError('plugin host runtime needs a valid mode');
  }
  const sessionLimit = supplied.sessionLimit === undefined ? DEFAULT_SESSION_LIMIT : supplied.sessionLimit;
  if (!Number.isSafeInteger(sessionLimit) || sessionLimit < 1 || sessionLimit > 4096) {
    throw new TypeError('invalid plugin host runtime sessionLimit');
  }
  const trackingLimit = supplied.trackingLimit === undefined ? DEFAULT_TRACKING_LIMIT : supplied.trackingLimit;
  if (!Number.isSafeInteger(trackingLimit) || trackingLimit < 1 || trackingLimit > 4096) {
    throw new TypeError('invalid plugin host runtime trackingLimit');
  }

  // The wiring is FORWARDED VERBATIM: its closed key set, its accessor refusal and its
  // per-key checks all belong to `createQzoneRuntime` (qzone-runtime-wiring.mjs:228-249), and
  // forwarding it unchanged is what keeps this assembly from ever being the looser of the two.
  // Only the container shape is checked here, with the runtime's own message.
  const writeWiring = supplied.writeWiring;
  if (writeWiring !== undefined
      && (writeWiring === null || typeof writeWiring !== 'object' || Array.isArray(writeWiring))) {
    throw new TypeError('invalid write wiring dependencies');
  }

  /** sessionId -> frozen ledger. THE cache: one ledger per session for its whole life. */
  const ledgers = new Map();
  let tornDown = false;

  /** The live epoch, or `null` after teardown (the plugin reads that as "generation retired"). */
  const liveEpoch = () => (tornDown ? null : sourceEpoch);

  /**
   * THE ONLY PLACE A LEDGER IS CREATED, and it is the trusted one (see the header).
   *
   * The ledger is frozen, mirroring `qzone-source-lifetime-offline.mjs:44`: a consumer must
   * not be able to replace `disconnect` on a ledger several agents share.
   *
   * @throws {TypeError} on a malformed session id; {Error} past the session limit or after teardown.
   */
  function getLedger(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new TypeError('invalid sessionId');
    if (tornDown) throw new Error('plugin host runtime is torn down');
    const existing = ledgers.get(sessionId);
    if (existing !== undefined) return existing;
    if (ledgers.size >= sessionLimit) throw new Error('plugin host runtime ledger limit reached');
    const ledger = Object.freeze(createQzoneOriginLedger({ sessionId, epoch: sourceEpoch, trackingLimit }));
    ledgers.set(sessionId, ledger);
    return ledger;
  }

  /**
   * Drop a session's ledger and kill it.
   *
   * Mirrors `qzone-source-lifetime-offline.mjs:73-80` (the reviewed per-session revoke): the
   * ledger is disconnected BEFORE it becomes unreachable, so a consumption minted from it stops
   * satisfying `authorizeSource`, and the next `getLedger` mints a fresh one. The plugin calls
   * this only on a CLEAN session boundary — a ledger killed by a runtime fault must stay cached
   * and dead, because replacing it would reopen a replay window.
   *
   * @returns `true` when a ledger was dropped, `false` when there was none.
   */
  function invalidate(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new TypeError('invalid sessionId');
    if (tornDown) return false;
    const ledger = ledgers.get(sessionId);
    if (ledger === undefined) return false;
    ledgers.delete(sessionId);
    try { ledger.disconnect(); } catch { /* a frozen ledger's disconnect cannot throw */ }
    return true;
  }

  /**
   * Is this consumption the one THIS module is willing to trust?
   *
   * Three gates, all fail-closed:
   *   1. it must be a genuinely branded ledger consumption (`isOriginLedgerConsumption`);
   *   2. its session must already have a CACHED ledger — a dispatch never mints one;
   *   3. that ledger's own `ownsConsumption` must accept it, which is what rejects a
   *      consumption branded by another ledger object (a foreign session, or one this runtime
   *      already invalidated).
   *
   * The session id is read through a property DESCRIPTOR so a hostile getter cannot run here;
   * the runtime additionally normalises anything but strict `true` to false.
   */
  function authorizeSource(consumption) {
    if (!isOriginLedgerConsumption(consumption)) return false;
    const sessionId = ownValue(consumption, 'sessionId');
    if (typeof sessionId !== 'string') return false;
    const ledger = ledgers.get(sessionId);
    if (ledger === undefined) return false;
    try {
      return ledger.ownsConsumption(consumption) === true;
    } catch {
      return false;
    }
  }

  /** The runtime's per-session lookup. Deliberately does NOT create: `null` is the closed answer. */
  function getBridgeSessions(sessionId) {
    if (typeof sessionId !== 'string') return null;
    return ledgers.get(sessionId) ?? null;
  }

  /**
   * The object the plugin reads. Three members — exactly the ones it calls
   * (`plugins/qzone-safe/index.mjs:127-217`); nothing else is offered, so nothing else can be
   * depended on by accident.
   */
  const sourceLifetime = Object.freeze({
    sourceEpoch: liveEpoch,
    getLedger,
    invalidate,
  });

  const runtime = createQzoneRuntime({
    store,
    botQq,
    sourceEpoch,
    authorizeSource,
    getConnectionEpoch,
    call,
    getBridgeSessions,
    clock,
    mode,
    trackingLimit,
    // The host approval hook. Both members are the caller's; this module has no policy. An
    // EXACTLY-two-key frozen frame because the runtime refuses anything else
    // (qzone-runtime-wiring.mjs:195-200).
    operationAuthorization: Object.freeze({ approveOperation, replayStore }),
    // ABSENT stays absent: forwarding an explicit `undefined` would still look "opted in" to
    // the runtime's own descriptor check, and `buildWriteWiring` only special-cases the absent
    // object. So the key is added ONLY when the caller supplied one.
    ...(writeWiring === undefined ? {} : { writeWiring }),
  });

  /**
   * Describe the write wiring STRUCTURALLY. Reporting only — see the header.
   *
   * `wired` here means "the keys a complete wiring needs are present and well typed", which is
   * the same rule `buildWriteWiring` applies (qzone-runtime-wiring.mjs:107-158). It does NOT
   * promise a write will succeed (mode, quota, the host verdict and the platform all still
   * decide) and it cannot open anything: the runtime re-checks every one of these facts at
   * dispatch time. `incomplete` is the important answer — it is what keeps `status()` from
   * reporting a wiring that would only ever refuse `write-wiring-incomplete`.
   */
  function writeWiringSummary() {
    if (writeWiring === undefined) {
      return Object.freeze({ supplied: false, status: 'not-supplied', actions: Object.freeze([]) });
    }
    try {
      const send = ownValue(writeWiring, 'send');
      const writePath = ownValue(writeWiring, 'writePath');
      const source = ownValue(writeWiring, 'source');
      const actions = ownValue(writeWiring, 'actions');
      const audit = ownValue(writeWiring, 'audit');
      const names = Array.isArray(actions) ? [...actions] : [];
      const complete = typeof send === 'function' && typeof writePath === 'function'
        && WRITE_SOURCES.has(source)
        && Array.isArray(actions) && actions.length > 0
        && names.every((name) => typeof name === 'string' && WRITE_TOOLS.has(name))
        && (audit === undefined
          || (audit !== null && typeof audit === 'object' && typeof audit.recordWrite === 'function'));
      return Object.freeze({
        supplied: true,
        status: complete ? 'wired' : 'incomplete',
        actions: Object.freeze(names.filter((name) => typeof name === 'string')),
      });
    } catch {
      // Unreachable after a successful construction (the runtime reads the same keys), kept so
      // a future hostile container cannot turn a status probe into an exception.
      return Object.freeze({ supplied: true, status: 'incomplete', actions: Object.freeze([]) });
    }
  }

  /**
   * Report what THIS module actually owns. PURE: no clock read, no epoch read, no ledger
   * creation, and no call into the runtime (see the header on why).
   */
  function status() {
    return Object.freeze({
      tornDown,
      mode,
      sourceEpoch: liveEpoch(),
      writeWiring: writeWiringSummary(),
      ledgers: Object.freeze({
        count: ledgers.size,
        limit: sessionLimit,
        trackingLimit,
        sessions: Object.freeze([...ledgers.keys()].sort()),
      }),
    });
  }

  /**
   * Forward one dispatch to the runtime and return ITS result unchanged.
   *
   * No re-encoding and no vocabulary of its own: what the caller reads is exactly what
   * `qzone-runtime-wiring.mjs` decided (`write-not-wired`, `origin-unverified`,
   * `write-not-enabled`, the write composition's own `{stage, reason, sent, ...}`, ...).
   *
   * That holds AFTER teardown too, and it is the reason there is no lifecycle branch here.
   * `teardown()` disconnects and drops every ledger it created, so a dispatch arriving
   * afterwards fails the runtime's own origin check (no ledger ⇒ no branded consumption ⇒
   * `origin-unverified`) and the attempt is audited like any other refused dispatch. Inventing
   * a private `runtime-torn-down` error here would have added vocabulary the caller cannot
   * know, while claiming a fact ('nothing was dispatched') this layer does not own.
   */
  function dispatch(action, input, context) {
    return runtime.dispatch(action, input, context);
  }

  /**
   * Idempotent teardown. Disconnects the ledgers THIS module created and forgets them.
   *
   * It never closes the injected store / replay store / transports — those are the caller's
   * objects, and this assembly did not open them.
   *
   * @returns `true` on the first call, `false` on every later one.
   */
  function teardown() {
    if (tornDown) return false;
    tornDown = true;
    for (const ledger of ledgers.values()) {
      try { ledger.disconnect(); } catch { /* already frozen and latched */ }
    }
    ledgers.clear();
    return true;
  }

  return Object.freeze({
    // `epoch` is what the plugin compares against `sourceLifetime.sourceEpoch()` on every
    // lookup (plugins/qzone-safe/index.mjs:127-139). It stays the constant this runtime was
    // built with; a NEW generation means a NEW runtime, which is also what the runtime's own
    // connection-epoch latch requires.
    epoch: sourceEpoch,
    dispatch,
    sourceLifetime,
    status,
    teardown,
  });
}
