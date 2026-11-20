// Production-shaped composition root for QZone reads. Offline-only in this
// revision: no real QQ/OneBot call is made unless the injected `call` does so,
// and tests inject fakes. Writes are fail-closed by DEFAULT (`write-not-wired`)
// because this module composes no write transport of its own; an explicit
// `writeWiring` opt-in (see below) hands a write to a host-supplied
// send/writePath pair, and nothing here ever invents one.
//
// Dispatch order (fixed):
//   1. context/mode/disconnect checks
//   2. total switch + per-tool gate (authorizeTool on a fresh store.read())
//   3. input validation, callId single-use check
//   4. origin ledger: peekCall(callId) -> consume(...)  (failure => origin-unverified)
//   5. Writes, ONLY when `writeWiring` is composed: hand {action, input, consumption,
//      connectionEpoch} to the approved-write composition and return its result. Placed
//      BEFORE the binding mint because a publish has no `target_uin` to mint from.
//   6. trusted binding mint from the consumption, current epoch, botQq, targetQq
//   7. write tools => write-not-wired (no opt-in); read_comments defaults to tool-not-wired
//   8. read_posts, or explicitly configured own-new-comment reads, use the
//      existing binding-gated reader (authorizeBinding)
// Every outcome that reaches step 2 or later is audited.
//
// ctx is {sessionId, callId}, optionally with a same-process branded ledger
// consumption. Turn/step are NOT on DSH exec; they come from the ledger's own
// observed tool/call events. A branded consumption is not transferable across
// processes and is not a substitute for an authenticated production channel.
// Optional operationAuthorization = { approveOperation, replayStore } adds a
// host-approved frozen operation and a persistent B2 claim before platform I/O.
// The host owns approveOperation's policy and explicitly initializes replayStore;
// omission preserves the pre-existing origin-only path, not B3 protection.
// This composition trusts host code and does not close a direct gateway bypass.
//
// Optional writeWiring = { send, writePath, source, actions, audit? } composes the two
// approved-write modules for the write tools. An optional `audit` (the write-audit
// sink, `qzone-write-audit-offline.mjs`) turns on the pre-send INTENT and the post-send
// RESULT row of each write in `state.writeAudit`.
//
// ⚠️ THIS MODULE DOES NOT WRITE THOSE ROWS ITSELF (t54). It would have to invent them: at the
// moment it could write, no `prepare()` has run, so there is no `authorizationId`, no approved
// snapshot and no operator — an earlier revision did exactly that and produced a pseudo-audit. The
// sink is therefore handed DOWN to the two compositions, which own the frozen post-approval
// operation and the write path's own classification:
//   · `intent`  — after the B2 claim, immediately before `send`. Unwritable ⇒ nothing is sent.
//   · `result`  — after `send`, from the write path's own verdict. Unwritable ⇒ the caller still
//                 gets the REAL outcome and `sent` plus `auditFailed: true`; nothing is retried and
//                 nothing is re-reported as unsent.
// The `approval` row belongs to `createQzoneApprovalAuditRecorder`, inside the broker's `decide()`.
// When `audit` is absent, the write path is exactly what it was before this option existed. It is OFF unless explicitly supplied:
// with no writeWiring every write tool keeps its pre-existing refusal, unchanged
// (`write-not-wired`, or — for publish, whose MCP input carries no single
// `target_uin` — the earlier `origin-unverified`). An opt-in that is missing a
// dependency (`send` / `writePath` / `source`, a usable `operationAuthorization`,
// or an absent, empty or invalid `actions` list) refuses as
// `write-wiring-incomplete`: it never half-opens, and it never crashes. Three more
// closed refusals keep the opt-in honest: `write-not-enabled` (mode is not
// 'enabled'), `write-action-not-composed` (an `actions` list left this action out)
// and `write-dispatch-failed` (the composition threw, so the outcome is unknown).
// The write transport itself is NOT composed here: `send` and `writePath` are host
// injections, this module only decides whether a write may be handed to them.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { authorizeTool, isActiveTime } from './qzone-policy-offline.mjs';
import { runQzoneHealthProbe } from './qzone-health-probe-runtime.mjs';
import { dispatchNotice } from './qzone-notice-runtime.mjs';
import { createQzoneOwnerNoticeSender } from './qzone-owner-notice-adapter.mjs';
import { appendOfflineAudit } from './qzone-audit-offline.mjs';
import { createQzoneTrustedBindingGate } from './qzone-trusted-binding.mjs';
import { createQzoneLiveFriendRead } from './qzone-live-friend-read.mjs';
import { createQzoneLiveFriendProof } from './qzone-live-friend-proof.mjs';
import { createQzoneBoundReadTransport } from './qzone-bound-read-transport.mjs';
import { validateQzoneMcpInput } from './qzone-mcp-contract.mjs';
import { isOriginLedgerConsumption } from './qzone-origin-ledger-offline.mjs';
import { snapshotExceptionReads } from './qzone-read-scope-offline.mjs';
import { createQzoneOperationAuthorizer } from './qzone-operation-authorization-offline.mjs';
import { createQzonePublishAuthorizer } from './qzone-approved-publish-dispatch-offline.mjs';
import { createQzoneWriteAuthorizer } from './qzone-approved-comment-dispatch-offline.mjs';

const MODES = new Set(['disabled', 'read-only', 'enabled']);
const KNOWN_TOOLS = new Set(['read_posts', 'read_comments', 'publish', 'comment', 'reply', 'like']);
const WRITE_TOOLS = new Set(['publish', 'comment', 'reply', 'like']);
const CTX_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** The only keys `writeWiring` may carry. Anything else is a construction-time TypeError. */
const WRITE_WIRING_KEYS = Object.freeze(['send', 'writePath', 'source', 'actions', 'audit']);
/**
 * The write sources `qzone-write-path-offline.mjs` accepts for an audited reply
 * (`qzone-write-path-offline.mjs:854`), and the two this composition is willing to stamp on any
 * other write. A third value would be refused deep inside the write path for a reply and silently
 * carried into the reservation for the other actions, so it is refused here instead.
 */
const WRITE_SOURCES = new Set(['qq', 'patrol']);

/**
 * Turn the optional `writeWiring` snapshot into either `undefined` (not composed), a
 * `{ complete: false }` marker (composed but unusable), or a frozen, ready composition.
 *
 * WHY AN INCOMPLETE OPT-IN IS A MARKER AND NOT A THROW: the task it answers is "may this call be
 * dispatched?", and the answer for every write is "no" — which is exactly what a controlled
 * dispatch refusal reports. Throwing at construction would instead take the WHOLE runtime down,
 * including the read path, because one write dependency was mistyped. The marker cannot half-open
 * anything: `dispatch` refuses every write with `write-wiring-incomplete` while it is present, and
 * the read path does not read it at all.
 *
 * The two approved-write modules are instantiated ONCE, here, with the runtime's OWN
 * `authorizer`. They are trusted, side-effect-free factories whose only failure mode is a
 * constructor TypeError (a non-function `writePath`, a missing authorizer, an empty `source`), so
 * a throw is caught and becomes the same `{ complete: false }` marker rather than an exception a
 * caller has to predict.
 *
 * `settleStore` (M3) — THE ONE STORE THE BREAKER MAY COUNT IN, AND WHY IT IS NOT A `writeWiring`
 * KEY. It is the runtime's OWN `options.store`: the same writable handle the policy gate reads
 * (`authorizeTool(store.read(), …)`), the same one the quota ledger's `ledger.reservations` lives
 * in, and — through `createQzoneWriteAudit({ store })` — the same one the write-audit rows land in.
 * `settleOfflineWrite` looks a reservation up BY ID in `state.ledger.reservations` and records the
 * verdict in `state.outcomes`; against any OTHER handle that lookup misses, so the settlement would
 * throw 'missing reservation' or count into a database nobody reads. One database is the whole
 * precondition, which is exactly why it must NOT become a caller-injectable wiring key: a second
 * handle is not a configuration choice here, it is a defect.
 *
 * IT IS DELIBERATELY **NOT** VALIDATED HERE. A store that is missing or unusable is already
 * impossible (the runtime refuses to construct without `read`/`update`), and `settleApprovedWriteOutcome`
 * re-checks `typeof store.update === 'function'` on every settlement. So "passed but wrong" cannot
 * become "silently counted"; at worst it becomes `{ settled: false }` — the same fail-quiet result
 * as not passing it at all.
 */
function buildWriteWiring(supplied, authorizer, clock, settleStore) {
  if (supplied === undefined) return undefined;
  // The write composition reuses the runtime's authorizer on purpose: a second instance would
  // carry its own `issued` WeakMap (so a ticket minted by one is not a ticket for the other) and
  // its own view of `isCurrent`, i.e. two different answers to "is this still approved?".
  if (authorizer === undefined) return Object.freeze({ complete: false });
  const send = supplied.send;
  const writePath = supplied.writePath;
  const source = supplied.source;
  if (typeof send !== 'function' || typeof writePath !== 'function' || !WRITE_SOURCES.has(source)) {
    return Object.freeze({ complete: false });
  }
  if (!Array.isArray(supplied.actions) || supplied.actions.length === 0) {
    return Object.freeze({ complete: false });
  }
  const actions = new Set();
  for (const name of supplied.actions) {
    if (typeof name !== 'string' || !WRITE_TOOLS.has(name)) return Object.freeze({ complete: false });
    actions.add(name);
  }
  // OPTIONAL audit sink. A supplied one that is NOT a sink makes the whole opt-in incomplete, for
  // the same reason a missing `send` does: the caller asked for auditing and would silently get
  // none. An ABSENT one keeps the pre-existing behaviour byte for byte.
  //
  // THE SINK IS PASSED DOWN TO THE COMPOSITIONS, NOT USED HERE (t54). Only they ever see the frozen
  // post-`prepare` operation, its real `authorizationId` and the write path's own classification, so
  // only they can record an honest `intent`/`result` pair. An earlier revision built the frame in
  // THIS function from the caller's `input`, before any approval existed — a pseudo-audit describing
  // an operation nobody had authorised yet. That block is gone; nothing in this branch writes a
  // write-audit row any more.
  const audit = supplied.audit;
  if (audit !== undefined && (audit === null || typeof audit !== 'object' || typeof audit.recordWrite !== 'function')) {
    return Object.freeze({ complete: false });
  }
  // The audit sink needs a trusted clock for its row timestamps; without one the composition could
  // not stamp a row at all, so it is part of the opt-in's completeness.
  if (audit !== undefined && typeof clock !== 'function') return Object.freeze({ complete: false });
  const auditDeps = audit === undefined ? {} : { audit, clock };
  // G1/M2/M3 — THE BREAKER'S STORE, HANDED TO BOTH COMPOSITIONS `store: settleStore`.
  //
  // `settleStore` is the runtime's own writable `options.store` (see this function's header for
  // why it can only be that one). Passing it is what turns M2's wired-but-unpowered settlement on:
  // without it `settleApprovedWriteOutcome` returns `{ settled: false, failed: false }` on EVERY
  // write and the breaker counts nothing.
  //
  // "NOT PASSED ⇒ NOT SETTLED" IS THE FAIL-QUIET CONTRACT, kept verbatim: `undefined` reaches the
  // composition, which forwards `store: undefined`, and the shared settlement helper checks
  // `typeof store.update === 'function'` and returns `{ settled:false, failed:false }` WITHOUT
  // throwing and WITHOUT touching state. So a caller that composes the runtime in a context with no
  // writable store (a probe script, a fixture) keeps the pre-M3 behaviour byte for byte instead of
  // crashing at the first write. That branch is pinned by `test-qzone-breaker-wiring.mjs` BW-4.
  //
  // `log` is NOT forwarded: the compositions default to `console.warn` for the one line they emit
  // ("an unexpected outcome appeared, nothing was settled this round"), and changing that routing
  // is not part of M3.
  const settleDeps = settleStore === undefined ? {} : { store: settleStore };
  let publish;
  let interaction;
  try {
    if (actions.has('publish')) {
      publish = createQzonePublishAuthorizer({ authorizer, writePath, send, source, ...auditDeps, ...settleDeps });
    }
    if (actions.has('comment') || actions.has('reply') || actions.has('like')) {
      interaction = createQzoneWriteAuthorizer({ authorizer, writePath, send, source, ...auditDeps, ...settleDeps });
    }
  } catch {
    return Object.freeze({ complete: false });
  }
  return Object.freeze({ complete: true, actions, publish, interaction, audit });
}

const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonNegative = (value) => Number.isSafeInteger(value) && value >= 0;
const digest = (...parts) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);

function plainOwnData(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const out = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    out[key] = descriptor.value;
  }
  return out;
}

function normalizeTarget(input) {
  const raw = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'target_uin')?.value : undefined;
  if (typeof raw === 'number') return positive(raw) ? raw : null;
  if (typeof raw === 'string' && /^[1-9]\d*$/.test(raw)) {
    const n = Number(raw);
    return String(n) === raw && positive(n) ? n : null;
  }
  return null;
}

export function createQzoneRuntime(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('invalid runtime options');
  const operationDescriptor = Object.getOwnPropertyDescriptor(options, 'operationAuthorization');
  if ((operationDescriptor && !Object.hasOwn(operationDescriptor, 'value')) ||
      (!operationDescriptor && 'operationAuthorization' in options)) throw new TypeError('invalid operation authorization dependencies');
  let operationAuthorization;
  if (operationDescriptor?.value !== undefined) {
    const supplied = operationDescriptor.value;
    const snapshot = plainOwnData(supplied, ['approveOperation', 'replayStore']);
    if (!snapshot || Reflect.ownKeys(supplied).length !== 2 || typeof snapshot.approveOperation !== 'function' ||
        typeof snapshot.replayStore?.read !== 'function' || typeof snapshot.replayStore?.update !== 'function') {
      throw new TypeError('invalid operation authorization dependencies');
    }
    operationAuthorization = Object.freeze(snapshot);
  }
  const exceptionDescriptor = Object.getOwnPropertyDescriptor(options, 'exceptionReads');
  if ((exceptionDescriptor && !Object.hasOwn(exceptionDescriptor, 'value')) ||
      (!exceptionDescriptor && 'exceptionReads' in options)) throw new TypeError('invalid exception read dependencies');
  const exceptionReads = exceptionDescriptor?.value === undefined ? undefined : snapshotExceptionReads(exceptionDescriptor.value);
  const probeDescriptor = Object.getOwnPropertyDescriptor(options, 'healthProbe');
  if ((probeDescriptor && !Object.hasOwn(probeDescriptor, 'value')) ||
      (!probeDescriptor && 'healthProbe' in options)) throw new TypeError('invalid health probe dependencies');
  let healthProbe;
  if (probeDescriptor?.value !== undefined) {
    const supplied = probeDescriptor.value;
    const keys = ['adminQq', 'readOwnSpace', 'serviceReady'];
    const snapshot = plainOwnData(supplied, keys);
    if (!snapshot || Reflect.ownKeys(supplied).length !== keys.length ||
        typeof snapshot.adminQq !== 'string' || !/^[1-9]\d{0,19}$/.test(snapshot.adminQq) ||
        typeof snapshot.readOwnSpace !== 'function' || typeof snapshot.serviceReady !== 'function') {
      throw new TypeError('invalid health probe dependencies');
    }
    healthProbe = Object.freeze(snapshot);
  }
  // The write opt-in is parsed here but COMPOSED after `operationAuthorizer` exists (below): the
  // composition reuses that exact instance, so it cannot be built before it.
  //
  // A MISSING dependency is NOT a construction error (that would kill the read path of a runtime
  // whose write half is merely misconfigured); it becomes `write-wiring-incomplete` at dispatch.
  // An UNKNOWN key is a construction error: a typo must not be silently ignored, because the
  // write would then run without the dependency the caller believed it had supplied.
  const writeDescriptor = Object.getOwnPropertyDescriptor(options, 'writeWiring');
  if ((writeDescriptor && !Object.hasOwn(writeDescriptor, 'value')) ||
      (!writeDescriptor && 'writeWiring' in options)) throw new TypeError('invalid write wiring dependencies');
  let writeWiringOptions;
  if (writeDescriptor?.value !== undefined) {
    const supplied = writeDescriptor.value;
    if (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied)) {
      throw new TypeError('invalid write wiring dependencies');
    }
    const snapshot = {};
    for (const key of Reflect.ownKeys(supplied)) {
      if (typeof key !== 'string' || !WRITE_WIRING_KEYS.includes(key)) {
        throw new TypeError('invalid write wiring dependencies');
      }
      const descriptor = Object.getOwnPropertyDescriptor(supplied, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('invalid write wiring dependencies');
      }
      snapshot[key] = descriptor.value;
    }
    writeWiringOptions = Object.freeze(snapshot);
  }
  const { store, botQq, getConnectionEpoch, sourceEpoch, authorizeSource, call, getBridgeSessions, clock, mode, trackingLimit = 4096,
    sendOwnerReceipt } = options;
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function' ||
      !positive(botQq) || typeof getConnectionEpoch !== 'function' || typeof call !== 'function' ||
      typeof getBridgeSessions !== 'function' || typeof clock !== 'function' || !MODES.has(mode) ||
      typeof sourceEpoch !== 'string' || !CTX_ID.test(sourceEpoch) || typeof authorizeSource !== 'function' ||
      !Number.isSafeInteger(trackingLimit) || trackingLimit < 1 || trackingLimit > 4096) {
    throw new TypeError('invalid qzone runtime dependencies');
  }
  const ownerNoticeSender = sendOwnerReceipt === undefined ? undefined : createQzoneOwnerNoticeSender(sendOwnerReceipt);

  const gate = createQzoneTrustedBindingGate();
  const readEpoch = () => {
    try {
      const epoch = getConnectionEpoch();
      return nonNegative(epoch) ? epoch : null;
    } catch {
      return null;
    }
  };
  // This local guard rejects a changed or unavailable connection epoch. Its
  // protection depends on epochs never repeating during this instance's life;
  // production still needs authenticated source/connection binding and active
  // invalidation, including across tracker or process recreation.
  const creationEpoch = readEpoch();
  let invalidated = creationEpoch === null;
  const currentEpoch = () => {
    const epoch = readEpoch();
    if (epoch === null || epoch !== creationEpoch) invalidated = true;
    return invalidated ? null : epoch;
  };
  // Stable helper identity across runs. Reject stale recovery inside the store
  // transaction so neither pause clearing nor its success audit can commit.
  const healthProbeStore = healthProbe === undefined ? undefined : {
    ...store,
    read: () => store.read(),
    update(fn) {
      return store.update(state => {
        const next = fn(state);
        const clearsPause = (state.accessPaused === true && next.accessPaused === false) ||
          (state.writePaused === true && next.writePaused === false);
        if (clearsPause && currentEpoch() === null) throw new Error('disconnected');
        return next;
      });
    },
  };
  const now = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid clock');
    return value;
  };
  // Optional, host-only composition. The host owns the approval policy and the
  // explicitly initialized B2 store. No signing key, production activation or
  // claim that same-process code is isolated is implied by this option.
  const operationAuthorizer = operationAuthorization === undefined ? undefined : createQzoneOperationAuthorizer({
    store: operationAuthorization.replayStore, accountId: botQq, sourceEpoch, clock: now,
    approveOperation: operationAuthorization.approveOperation,
    isCurrent: (operation, consumption) => currentEpoch() === operation.connectionEpoch &&
      consumption.epoch === sourceEpoch && authorizeOrigin(consumption) &&
      authorizeTool(store.read(), operation.action).allowed === true,
  });

  // The write composition, built ONCE with `operationAuthorizer` itself (Q3). `undefined` means
  // "not opted in" and keeps every write refusal exactly as it was before this option existed.
  // `{ complete: false }` means "opted in but unusable": every write is refused with
  // `write-wiring-incomplete` and nothing is ever sent.
  //
  // `now` is the runtime's own validated clock; it is only used to stamp write-audit rows, and
  // `buildWriteWiring` refuses an audited opt-in without one.
  // `store` (the fourth argument) is the runtime's own writable handle — the SAME one the gate,
  // the quota ledger and the write-audit sink use. It is passed unconditionally: it is not an
  // opt-in, because "compose writes" already is the opt-in and a write that happens without its
  // outcome being counted is exactly the gap M3 closes. When `writeWiring` itself is absent this
  // argument is simply unused (the function returns early).
  const writeWiring = buildWriteWiring(writeWiringOptions, operationAuthorizer,
    operationAuthorizer === undefined ? undefined : now, store);

  // Binding-gated proof for the live-friend-read production path. The reader
  // passes the minted binding back in; it is accepted only while it is still a
  // genuine binding for the live epoch and botQq. A reconnect (new epoch) or a
  // forged/copied object yields null, so the reader fails closed.
  const bindingConsumptions = new WeakMap();
  function sourceStillAuthorized(binding) {
    if (!gate.verify(binding, { connectionEpoch: currentEpoch(), botQq })) return false;
    return authorizeOrigin(bindingConsumptions.get(binding));
  }
  function authorizeBinding(binding) {
    if (!sourceStillAuthorized(binding)) return null;
    const consumption = bindingConsumptions.get(binding);
    // TWO SOURCES OF TRUST, TWO SHAPES:
    //
    //  · 'qq-inbound' -> `requested`. A real QQ message is the origin; the binding above already
    //    proved it, so there is nothing further to check.
    //
    //  · 'schedule'   -> `proactive`, but ONLY when this exact requestId has an outstanding QZone
    //    opportunity. That equality is what makes 'schedule' mean "the bridge offered THIS agent a
    //    chance to look at the space" rather than "some background delivery happened". Without
    //    the offer hit, a schedule consumption from any other platform is refused HERE -- the
    //    binding gate accepts the origin on SHAPE alone and cannot see offers.
    //
    // WHY THE OFFER CHECK LIVES HERE AND NOT IN `current()`: this function answers ADMISSION
    // ("may this requestId read at all?"), while SINGLE USE is enforced downstream inside
    // `reserveOfflineRead`'s transaction via `usedOpportunities` -- that is what stops every new
    // callId from earning a fresh free browse. A second check in `current()` would duplicate the
    // admission test without strengthening single use, and would pay a store read on all nine
    // guard invocations instead of the three proof checks.
    //
    // A store that cannot be read yields `null` (fail closed): a broken ledger must not be
    // evidence that an offer exists.
    if (consumption?.origin === 'schedule') {
      let offers;
      try {
        offers = store.read().offlineOpportunityOffers;
      } catch {
        return null;
      }
      // The requestId comes from the TRUSTED consumption, never from a model-supplied argument, and
      // it is the same value the bridge registered before delivery.
      const offered = offers !== null && typeof offers === 'object' && !Array.isArray(offers) &&
        Object.hasOwn(offers, consumption.requestId);
      if (!offered) return null;
      return {
        id: binding.referenceId,
        sourceProofId: binding.sourceProofId,
        source: 'proactive',
        opportunity: consumption.requestId,
        targetQq: binding.targetQq,
        botQq: binding.botQq,
        connectionEpoch: binding.connectionEpoch,
      };
    }
    return {
      id: binding.referenceId,
      sourceProofId: binding.sourceProofId,
      source: 'requested',
      targetQq: binding.targetQq,
      botQq: binding.botQq,
      connectionEpoch: binding.connectionEpoch,
    };
  }

  function createReader(platformCall = call, authorization) {
    const friendVerifier = createQzoneLiveFriendProof({ botQq, call: platformCall, getConnectionEpoch: currentOrThrow });
    const boundTransport = createQzoneBoundReadTransport({
      botQq,
      getConnectionEpoch: currentOrThrow,
      transport: {
        async get_qzone_msg_list(params) {
          return { kind: 'trusted-envelope', envelope: await platformCall('get_qzone_msg_list', params) };
        },
        // ── t43: the DETAIL method, without which a plain comment read cannot work. ──────────
        // The reader asks for `get_qzone_msg_detail` when the scope is `plain-comments`
        // (qzone-live-friend-read.mjs), and the bound transport raises a not-sent refusal when the
        // injected platform lacks the method. Only the LIST method used to be wired here, so a
        // comment read was refused as `unverified` AFTER the gate had been opened for it — the
        // feature looked enabled and answered "unverified", which reads like an authorization
        // failure rather than a missing wire.
        async get_qzone_msg_detail(params) {
          return { kind: 'trusted-envelope', envelope: await platformCall('get_qzone_msg_detail', params) };
        },
      },
    });
    return createQzoneLiveFriendRead({
      store,
      clock: now,
      authorizeBinding: authorization ? binding => authorization.check() ? authorizeBinding(binding) : null : authorizeBinding,
      isStillAuthorized: authorization ? binding => authorization.check() && sourceStillAuthorized(binding) : sourceStillAuthorized,
      verifyFriendship: friendVerifier.verify,
      transport: boundTransport,
      ...(exceptionReads === undefined ? {} : { exceptionReads: Object.freeze({
        ...exceptionReads,
        ...(authorization && exceptionReads.fetchPost ? { fetchPost: (operation, guard) => {
          authorization.beforeSend();
          return exceptionReads.fetchPost(operation, guard);
        } } : {}),
        ...(authorization && exceptionReads.fetchCommentPage ? { fetchCommentPage: (operation, guard) => {
          authorization.beforeSend();
          return exceptionReads.fetchCommentPage(operation, guard);
        } } : {}),
        contextFor(binding, action) {
          const consumption = bindingConsumptions.get(binding);
          return Object.freeze({ account: String(binding.botQq), connection: binding.connectionEpoch, sourceEpoch: consumption.epoch,
            sessionId: consumption.sessionId, requestId: consumption.requestId, callId: consumption.callId,
            action, targetQq: binding.targetQq, readId: binding.referenceId });
        },
      }) }),
    });
  }
  const reader = createReader();

  function currentOrThrow() {
    const epoch = currentEpoch();
    if (epoch === null) throw new Error('disconnected');
    return epoch;
  }

  const seenCalls = new Set();
  // Per-session charge counters. `seenCalls` is keyed by sessionId + callId (one
  // runtime can serve several sessions), so the budget must be counted per
  // session too: testing a bare `seenCalls.size` let the first session to reach
  // `trackingLimit` starve every other session served by the same runtime — the
  // key was split but the quota was not. `requestTurns` stays bounded because
  // distinct requestIds per session <= authenticated dispatches per session <=
  // this session's counter <= trackingLimit.
  const sessionCallCounts = new Map();
  const sessionCharge = (sessionId) => sessionCallCounts.get(sessionId) ?? 0;
  const chargeSession = (sessionId) => {
    sessionCallCounts.set(sessionId, sessionCharge(sessionId) + 1);
  };
  const refundSession = (sessionId) => {
    const next = sessionCharge(sessionId) - 1;
    if (next > 0) sessionCallCounts.set(sessionId, next);
    else sessionCallCounts.delete(sessionId);
  };
  // requestId -> turn, used to reject a second, inconsistent turn for the same
  // bridge request. It has no limit of its own ON PURPOSE, and it is still
  // bounded: one dispatch writes it at most once, and only for a dispatch that
  // became authenticated, whose budget was taken from this session's counter, so
  // distinct requestIds <= authenticated dispatches <= trackingLimit <= 4096.
  // If the counters ever get a "clear when full" behaviour, that bound
  // disappears AND this map starts growing without limit while replay
  // protection is re-opened (ABA replay).
  //
  // Both this map and `seenCalls` are keyed by sessionId + id, even though the
  // ledger is per-session. One runtime instance can serve several sessions
  // (`getBridgeSessions(ctx.sessionId)` is called per dispatch), and DSH tool
  // callIds are deterministic (`pi_tool_load_<hash of session:index:...>`), so two
  // sessions can legitimately present the same callId. With a bare key the second
  // session's call was refused as a replay and also poisoned the first session's
  // recorded turn. `scopeKey` keeps the two namespaces disjoint; it does not
  // authenticate anything, and it is still one charge per dispatch.
  const requestTurns = new Map();
  const scopeKey = (sessionId, id) => `${sessionId}\n${id}`;

  function audit(attemptKey, action, target, result, reason) {
    try {
      appendOfflineAudit(store, `dsp_${attemptKey}`, {
        time: now(), source: 'qq', action, target, content: '', result, reason,
      });
      return true;
    } catch {
      return false;
    }
  }

  // A synchronous `true` is the only acceptance. A thenable can never be one, and
  // a rejecting Promise used to surface as an *unhandled* rejection: dispatch had
  // already returned `origin-unverified` (because `!== true`), so nothing was left
  // to observe the rejection and Node killed the host process. Attach a no-op
  // handler so the failure stays a fail-closed refusal.
  function authorizeOrigin(consumption) {
    let verdict;
    try {
      verdict = authorizeSource(consumption);
    } catch {
      return false;
    }
    if (verdict !== null && typeof verdict === 'object' && typeof verdict.then === 'function') {
      try {
        verdict.then(() => {}, () => {});
      } catch {}
      return false;
    }
    return verdict === true;
  }

  async function dispatch(action, input, ctx) {
    let context = null;
    let attemptKey = digest('no-context', '', randomBytes(16).toString('hex'));
    let auditTarget = '0';
    const denied = (error, reason = 'policy') => {
      audit(attemptKey, KNOWN_TOOLS.has(action) ? action : 'read_posts', auditTarget, 'denied', reason);
      return { ok: false, error };
    };

    try {
      // Parsing lives inside the try so a hostile Proxy (throwing `get`, `has`
      // or `ownKeys`) yields `dispatch-failed` instead of escaping as a rejected
      // promise from an `async` function.
      //
      // The optional binding is an in-process branded consumption, not model input.
      const ctxData = plainOwnData(ctx, ['sessionId', 'callId']);
      const ctxKeys = ctx && typeof ctx === 'object' ? Reflect.ownKeys(ctx) : [];
      const validKeys = ctxKeys.length === 2 || (ctxKeys.length === 3 && ctxKeys.includes('binding'));
      const bindingDescriptor = ctxKeys.includes('binding') ? Object.getOwnPropertyDescriptor(ctx, 'binding') : null;
      context = ctxData && validKeys && (!bindingDescriptor || Object.hasOwn(bindingDescriptor, 'value')) &&
        typeof ctxData.sessionId === 'string' && CTX_ID.test(ctxData.sessionId) &&
        typeof ctxData.callId === 'string' && CTX_ID.test(ctxData.callId) ? ctxData : null;
      // Random nonce per attempt: audit ids must not collide across process restarts.
      attemptKey = digest(context ? context.sessionId : 'no-context', context ? context.callId : '',
        randomBytes(16).toString('hex'));
      const target = normalizeTarget(input);
      auditTarget = target !== null ? String(target) : '0';

      if (!context) return denied('missing-native-context');
      if (mode === 'disabled') return denied('disabled');
      if (currentEpoch() === null) return denied('disconnected');
      if (!KNOWN_TOOLS.has(action)) return denied('invalid-action');

      // 1. total switch + per-tool gate on a fresh state read
      const state = store.read();
      const toolGate = authorizeTool(state, action);
      if (!toolGate.allowed) return denied('tool-denied', 'policy');

      // 2. input validation and single-use callId
      if (!validateQzoneMcpInput(action, input)) return denied('invalid-input', 'other');
      const commentPostId = action === 'read_comments' ? Object.getOwnPropertyDescriptor(input, 'tid')?.value : null;
      // t30: the page window travels as a plain pair, read from the SAME `input` the contract
      // above already validated. Absent fields are OMITTED (not set to undefined) so the reader
      // applies its own default — that is what keeps an existing caller's request byte-identical.
      const pageWindow = {};
      {
        const posValue = Object.getOwnPropertyDescriptor(input, 'pos')?.value;
        if (posValue !== undefined) pageWindow.pos = posValue;
        const numValue = Object.getOwnPropertyDescriptor(input, 'num')?.value;
        if (numValue !== undefined) pageWindow.num = numValue;
      }
      const callScope = scopeKey(context.sessionId, context.callId);
      if (seenCalls.has(callScope)) return denied('origin-unverified', 'policy');
      // Never evict replay-protection entries while this runtime remains alive.
      // Exhaustion requires controlled recreation after all old ledgers are
      // invalidated; silently clearing on a reconnect would permit ABA replay.
      //
      // The budget is counted PER SESSION, not over the whole `seenCalls` set:
      // one runtime serves several sessions, so a bare size test let the first
      // session to reach `trackingLimit` deny every other session's tools with
      // `tracking-capacity` while their own ledgers were still healthy.
      //
      // The capacity check stays here (before the ledger consume, so a full set
      // denies without disturbing ledger state), but the `add` is deferred until
      // after the origin check below: an unauthenticated attempt must not be able
      // to burn a slot and permanently lock every later legitimate read out with
      // tracking-capacity.
      if (sessionCharge(context.sessionId) >= trackingLimit) return denied('tracking-capacity', 'policy');

      // 3. origin ledger consume (synchronous, before any await)
      let consumption;
      if (bindingDescriptor) {
        consumption = bindingDescriptor.value;
        if (!isOriginLedgerConsumption(consumption) || consumption.sessionId !== context.sessionId ||
            consumption.callId !== context.callId) return denied('origin-unverified', 'policy');
      } else {
        const ledger = getBridgeSessions(context.sessionId);
        if (!ledger || typeof ledger.peekCall !== 'function' || typeof ledger.consume !== 'function') {
          return denied('origin-unverified', 'policy');
        }
        const peek = ledger.peekCall(context.callId);
        if (!peek || !positive(peek.turn) || !positive(peek.step)) return denied('origin-unverified', 'policy');
        consumption = ledger.consume({ sessionId: context.sessionId, turn: peek.turn, step: peek.step, callId: context.callId });
      }
      // The trusted owner must generate a fresh sourceEpoch and retire all old
      // ledgers whenever an instance/connection is replaced. Matching this
      // identifier alone does not authenticate IPC or prove account identity.
      if (!isOriginLedgerConsumption(consumption) || consumption.sessionId !== context.sessionId ||
          consumption.callId !== context.callId || consumption.epoch !== sourceEpoch ||
          !authorizeOrigin(consumption)) return denied('origin-unverified', 'policy');
      // Budget is charged only after authentication succeeded, so a bogus callId
      // cannot spend it. The earlier `has` + `size >= trackingLimit` checks still
      // run before the ledger consume, so a full set denies without touching it.
      //
      // From here on the charge is provisional: everything below may still deny
      // for a reason that has nothing to do with the reader (replayed requestId,
      // unwired write tool, unwired read tool). Those denials call release() so a
      // refused dispatch cannot permanently occupy a slot — otherwise a model
      // retrying `read_comments` (a known tool that is still tool-not-wired)
      // would exhaust `trackingLimit` and lock out every later `read_posts`.
      // `release()` is only reachable before `reader.read`, so a genuine read
      // attempt always keeps its charge.
      //
      // The charge and the refund closure are BOTH created inside the try below.
      // Charging outside it left a seam: a throw raised while reading
      // `requestTurns` (or while building the closure) escaped to the outer
      // catch with the slot still charged and no way to refund it. The whole
      // provisional region must be covered, not just the statements after it.
      // `keptCharge` makes the refund idempotent and marks the point after which
      // the charge is genuine (a real read attempt always costs one unit).
      let keptCharge = false;
      let release = () => {};
      const refuse = (error, reason = 'policy') => {
        if (!keptCharge) release();
        return denied(error, reason);
      };
      let operationTicket = null;
      try {
        // Read the previous binding BEFORE charging, so a throw here still
        // happens with nothing to refund. Every statement after `add` is then
        // covered by `release`. `release` is still the no-op default here on
        // purpose: nothing has been charged yet, so a throw landing between this
        // point and `add` needs no refund.
        const requestScope = scopeKey(context.sessionId, consumption.requestId);
        const priorTurn = requestTurns.get(requestScope);
        const hadPriorTurn = priorTurn !== undefined;
        // Undo the provisional charge of this dispatch only. Restoring
        // `requestTurns` to its previous absence is what keeps the bound
        // intact: without it a released dispatch would leave a requestId
        // recorded while its callId was freed, so distinct requestIds could
        // exceed this session's charge count.
        release = () => {
          seenCalls.delete(callScope);
          refundSession(context.sessionId);
          if (!hadPriorTurn) requestTurns.delete(requestScope);
        };
        seenCalls.add(callScope);
        chargeSession(context.sessionId);
        // Every statement after the charge can fail: the requestTurns guard, the
        // bookkeeping write, mint, the WeakMap write, either tool gate. Refusals
        // release explicitly, and an unexpected throw is caught by the inner
        // catch and refunded too — otherwise it would escape with the slot still
        // charged and silently leak one unit of tracking budget per failure.
        if (priorTurn !== undefined && priorTurn !== consumption.turn) return refuse('origin-unverified', 'policy');
        requestTurns.set(requestScope, consumption.turn);

        // 4. write path — OPT-IN ONLY, and BEFORE the binding mint.
        //
        // ⚠️ THE ORDER IS LOAD-BEARING, NOT STYLE. `publish`'s MCP input is
        // `{content, ugc_right, target_uins?}` (`qzone-mcp-contract.mjs:24-28`): there is no
        // `target_uin`, so `normalizeTarget` yields null and `gate.mint` returns null
        // (`qzone-trusted-binding.mjs:43`). A write branch placed AFTER the mint is therefore
        // UNREACHABLE for publish, which is exactly what the pre-existing tests pin
        // (`publish => origin-unverified`). Opting into a write has to precede it.
        //
        // Skipping the mint here is NOT a boundary bypass, because a binding is a READ
        // capability and nothing else: it is consumed only by the reader
        // (`activeReader.read`/`readComments`) and by the reader's own
        // `authorizeBinding`/`sourceStillAuthorized`/`contextFor` proofs. No write module accepts
        // one. A write instead carries the branded ledger `consumption` down to the approved-write
        // composition, which performs its OWN host approval (`prepare`) and its OWN single durable
        // B2 `claim` inside the write-path transport closure — so this layer must not prepare or
        // claim a second time for the same quadruple.
        //
        // BOTH consumption branches above reach this point (A: caller-supplied branded
        // `binding`, B: `ledger.consume`), and both produce the fields the authorizer reads
        // (`sessionId`/`requestId`/`callId`/`origin`/`epoch`) — no new source root is involved.
        //
        // DEFAULT IS UNCHANGED: with no `writeWiring`, this block is skipped entirely, the mint
        // runs, and the `write-not-wired` refusal below is reached exactly as before.
        if (WRITE_TOOLS.has(action) && writeWiring !== undefined) {
          // The runtime's own mode gate. It was previously unobservable (no write was ever
          // composed), and "read-only" must not become "can write" merely because the host wired
          // a send function.
          if (mode !== 'enabled') return refuse('write-not-enabled', 'policy');
          // Two DIFFERENT closed refusals, kept distinct on purpose: "the opt-in is unusable"
          // (`write-wiring-incomplete`, a dependency is missing) and "this particular action was
          // not opted into" (`write-action-not-composed`, an `actions` list that left it out).
          // Flattening them would tell an operator to fix a dependency that is actually fine.
          if (writeWiring.complete !== true) return refuse('write-wiring-incomplete', 'other');
          if (!writeWiring.actions.has(action)) return refuse('write-action-not-composed', 'other');
          const composed = action === 'publish' ? writeWiring.publish : writeWiring.interaction;
          if (!composed || typeof composed.execute !== 'function') return refuse('write-wiring-incomplete', 'other');
          // From here the charge is KEPT: the chain below may spend a quota unit and may take a
          // durable B2 claim, and neither has a refund path (`reserveWrite` has no undo, and
          // deleting a claim would reopen the replay window it exists to close). A refusal decided
          // ABOVE this line refunds the tracking slot; nothing below may.
          keptCharge = true;
          // ── THE WRITE-AUDIT ROWS ARE NOT WRITTEN HERE (t54) ─────────────────────────────
          // An earlier revision built the frame at this point, from the model `input`, and wrote the
          // `intent` row before calling `execute()`. That was a PSEUDO-audit: no `prepare()` had run
          // yet, so there was no `authorizationId` (minted inside `prepare`), no trustworthy approved
          // snapshot, and no operator — the row described an operation nobody had authorised.
          //
          // The sink is instead handed DOWN to the composition (see `buildWriteWiring`), which is the
          // only layer that sees the frozen post-approval operation and the write path's own
          // classification. It records `intent` after the B2 claim and before `send`, and `result`
          // after `send` returns or throws. This branch therefore writes NO write-audit row at all
          // and simply forwards the composition's result — including the `auditFailed: true` the
          // composition sets when a requested row could not be recorded.
          let outcome;
          try {
            outcome = await composed.execute({ action, input, consumption, connectionEpoch: currentEpoch() });
          } catch {
            // The composition lets a store failure propagate on purpose ("I could not record
            // whether this happened" must not be flattened into "nothing happened"), so this is
            // reported as `unknown`, not as a refusal.
            audit(attemptKey, action, auditTarget, 'unknown', 'other');
            return { ok: false, error: 'write-dispatch-failed' };
          }
          if (!outcome || typeof outcome !== 'object') {
            audit(attemptKey, action, auditTarget, 'unknown', 'other');
            return { ok: false, error: 'write-dispatch-failed' };
          }
          // ONE audit row, in the EXISTING vocabulary (`success|failure|unknown|denied` ×
          // `policy|other|''`). The mapping is MEASURED against the two compositions, not guessed:
          //
          //   both modules build every refusal with `{ok:false, ...}` — including the transport-
          //   closure refusal, which therefore arrives as
          //   `{ok:false, outcome:'not-sent', sent:false, quotaConsumed:true}` (a unit WAS spent).
          //   So `ok!==true` covers both "refused before the reservation" and "refused after it".
          //   Mapping it to `denied` is right for both, but the distinction is NOT encoded in the
          //   reason: the caller still receives `quotaConsumed`/`reason` in the returned object, and
          //   the audit reason vocabulary (`policy|other|…`) has no word for it. Inventing one would
          //   change the settled audit format, which this change must not do.
          //
          //   ok!==true          -> denied / policy   (nothing was sent in either case)
          //   ok && 'success'    -> success / ''
          //   ok && 'failed'     -> failure / other   (it DID go out, the platform said no)
          //   ok && 'not-sent'   -> denied / other    (defensive: unreachable through the two
          //                       compositions TODAY, kept so a future composition that reports
          //                       ok:true+not-sent cannot silently map to `unknown`)
          //   ok && anything else-> unknown / other   (may or may not have gone out)
          let auditResult = 'unknown';
          let auditReason = 'other';
          if (outcome.ok !== true) {
            auditResult = 'denied';
            auditReason = 'policy';
          } else if (outcome.outcome === 'success') {
            auditResult = 'success';
            auditReason = '';
          } else if (outcome.outcome === 'failed') {
            auditResult = 'failure';
          } else if (outcome.outcome === 'not-sent') {
            auditResult = 'denied';
          }
          audit(attemptKey, action, auditTarget, auditResult, auditReason);
          // The composition's result is returned AS IS: it already distinguishes
          // reserved-and-not-sent from sent-and-unverified, and re-encoding it here would drop the
          // `quotaConsumed`/`sent`/`payload` evidence the caller needs. It also already carries
          // `auditFailed: true` when a write-audit row it was asked to write could not be recorded —
          // that flag is produced where the row is produced, never re-derived here.
          return outcome;
        }

        // 5. trusted binding mint
        const binding = gate.mint({ consumption, connectionEpoch: currentEpoch(), botQq, targetQq: target });
        if (!binding) return refuse('origin-unverified', 'policy');
        bindingConsumptions.set(binding, consumption);

        // 5. write-not-wired fallback: reached ONLY when no `writeWiring` was supplied.
        if (WRITE_TOOLS.has(action)) return refuse('write-not-wired', 'other');
        // `read_comments` no longer needs `exceptionReads.fetchCommentPage`: a PLAIN comment page is
        // an ordinary bound-transport read (t42). Only the reply-evidence path (`own-new-comment`,
        // which is reached through `exceptionReads` and therefore only when that adapter exists)
        // still needs the host's dedicated adapter — and that requirement lives inside the reader,
        // where the scope kind is actually known. Refusing the whole action here made the feature
        // unreachable for every host: `exceptionReads` is injected by nobody.
        if (action !== 'read_posts' && action !== 'read_comments') return refuse('tool-not-wired', 'other');

        // Both ledger-consumption paths must pass the same host approval. The
        // callback sees a frozen semantic operation; subsequent caller mutation
        // cannot replace the snapshot used by this dispatch. Declining never
        // falls back to origin-only authorization and never takes a B2 claim.
        let activeReader = reader;
        const expectedOperation = () => ({ action, input, consumption, connectionEpoch: currentEpoch() });
        if (operationAuthorizer) {
          operationTicket = await operationAuthorizer.prepare({ action, input, consumption, connectionEpoch: currentEpoch() });
          if (!operationTicket) return refuse('authorization-invalid');
          input = operationTicket.operation.input;
          if (!operationAuthorizer.verify(operationTicket, expectedOperation())) return refuse('authorization-invalid');
          const check = () => operationAuthorizer.verify(operationTicket, expectedOperation());
          const beforeSend = () => {
            if (!operationAuthorizer.claim(operationTicket, expectedOperation()).ok) throw new Error('authorization-invalid');
          };
          // A logical read may perform friendship proof plus list/detail I/O.
          // Commit B2 before the FIRST such call; recheck the same ticket before
          // EVERY later call without consuming a second time. Request-local
          // closures avoid associating concurrent dispatches through globals.
          activeReader = createReader((...args) => { beforeSend(); return call(...args); }, { check, beforeSend });
        }

        // From here the charge is kept for a GENUINE read attempt: the reader
        // was entered, so the transport cost is real even when it fails.
        keptCharge = true;

        // 6. read path (production live-friend-read)
        let result;
        try {
          // t30: the caller's page window is FORWARDED, not re-derived. `pos`/`num` are part of
          // the tool contract (`qzone-mcp-contract.mjs:10`), so the reader is the only place that
          // may decide what they mean; the runtime just passes them on. Omitting both reproduces
          // the previous hard-coded `pos: 0, num: 20` exactly, which is why existing callers and
          // tests need no change.
          result = action === 'read_comments'
            ? await activeReader.readComments(binding, commentPostId, pageWindow)
            : await activeReader.read(binding, pageWindow);
        } catch {
          audit(attemptKey, action, auditTarget, 'unknown', 'other');
          return action === 'read_comments' ? { ok: true, outcome: 'unknown', comments: [] } : { ok: true, outcome: 'unknown', posts: [] };
        }
        if (!result || result.allowed !== true) {
          // Billing follows the OBSERVED stage of the read, not its outcome:
          //
          //   no `reserved` marker  -> the reader committed nothing at all (a failed
          //       friendship proof, a stale source). No audited intent, no platform
          //       request: refund. Charging here let a repeatedly-unverifiable target
          //       burn `trackingLimit` slots and lock out every later read (M-1).
          //   `reserved: true` + `dispatched: false` -> a one-shot audited read intent
          //       IS now committed and stayed committed, but zero platform requests
          //       left the process. `reserved` alone says nothing about the platform
          //       call; the read reservation is already single-use per proof id, so
          //       charging tracking budget as well only lets a pre-dispatch recheck
          //       that keeps failing burn capacity — the same lockout class as M-1.
          //   `reserved: true` and no `dispatched: false` -> a real platform attempt
          //       (or a reader that predates the marker): keep the charge.
          //
          // Refunding here does not reopen replay: the ledger already retired this
          // callId (`consume` stores null), so a retry with the same callId is refused
          // as origin-unverified before reaching this branch.
          //
          // The boundary is the reader's `dispatched` flag, and it is deliberately
          // positional: the reader's clock is called once at entry and once more
          // after the reservation, both before `dispatched = true`, so a throw on
          // either of those refunds. From the third clock call onward the read may
          // already have reached the platform, so that path keeps the charge and
          // reports `unknown`. Do not "fix" the third-and-later case into a refund:
          // it would turn "the platform may have seen this read" into a free retry.
          const platformAttempted = result?.reserved === true && result?.dispatched !== false;
          if (!platformAttempted) {
            keptCharge = false;
            release();
          }
          audit(attemptKey, action, auditTarget, 'denied', 'policy');
          if (action === 'read_comments' && result?.reason === 'tool-not-wired') return { ok: false, error: 'tool-not-wired' };
          return { ok: false, error: 'read-denied', reason: typeof result?.reason === 'string' ? result.reason : 'unverified' };
        }
        if (result.outcome === 'success') {
          if (operationTicket && !operationAuthorizer.verify(operationTicket, expectedOperation())) {
            audit(attemptKey, action, auditTarget, 'unknown', 'policy');
            return action === 'read_comments' ? { ok: true, outcome: 'unknown', comments: [] } : { ok: true, outcome: 'unknown', posts: [] };
          }
          if (!audit(attemptKey, action, auditTarget, 'success', '')) return { ok: false, error: 'audit-failed' };
          // Only `posts`. An earlier revision forwarded a `page` object carrying the pre-filter row
          // count and the upstream total; that let a caller subtract `posts.length` and learn how many
          // rows were hidden, so it was removed (see the reader's "WHY NO COUNT IS RETURNED" header).
          // Do not reintroduce any count here, under any name.
          return action === 'read_comments'
            ? { ok: true, outcome: 'success', parent: result.parent, comments: result.comments }
            : { ok: true, outcome: 'success', posts: result.posts };
        }
        // `unknown` keeps its exact previous shape. It carries no count of any kind either: on this
        // path the outcome itself says the result is unverified, so there is nothing trustworthy to
        // report even if a caller asked.
        audit(attemptKey, action, auditTarget, 'unknown', 'other');
        return action === 'read_comments' ? { ok: true, outcome: 'unknown', comments: [] } : { ok: true, outcome: 'unknown', posts: [] };
      } catch {
        // Refund before reporting, so a throwing dependency cannot leak a slot.
        if (!keptCharge) release();
        audit(attemptKey, KNOWN_TOOLS.has(action) ? action : 'read_posts', auditTarget, 'unknown', 'other');
        return { ok: false, error: 'dispatch-failed' };
      } finally {
        if (operationTicket) operationAuthorizer.finish(operationTicket);
      }
    } catch {
      if (context) audit(attemptKey, KNOWN_TOOLS.has(action) ? action : 'read_posts', auditTarget, 'unknown', 'other');
      return { ok: false, error: 'dispatch-failed' };
    }
  }

  // Offline assembly only: the host must supply these dependencies. This does
  // not attest adapter trust/system isolation or enable production use; wiring
  // a real readOwnSpace requires separate authorization. No dispatch/tool hook.
  async function runHealthProbe() {
    if (healthProbe === undefined) return { status: 'not_configured' };
    if (mode === 'disabled' || currentEpoch() === null) return { status: 'not_eligible' };
    return runQzoneHealthProbe({
      store: healthProbeStore, botQq: String(botQq), now, adminQq: healthProbe.adminQq,
      serviceReady: () => {
        if (currentEpoch() === null) return false;
        const verdict = healthProbe.serviceReady();
        // Readiness is synchronous; observe a mistaken async rejection before
        // refusing it so it cannot escape as an unhandled host rejection.
        if (verdict !== null && (typeof verdict === 'object' || typeof verdict === 'function') &&
            typeof verdict.then === 'function') {
          try { verdict.then(() => {}, () => {}); } catch {}
          return false;
        }
        return verdict === true && currentEpoch() !== null;
      },
      activeTime: () => {
        const state = store.read();
        return isActiveTime(now(), state.activeStart, state.activeEnd);
      },
      readOwnSpace: async request => {
        if (currentEpoch() === null) return { status: 'unknown' };
        const result = await healthProbe.readOwnSpace(request);
        if (currentEpoch() === null) return { status: 'unknown' };
        return result;
      },
    });
  }

  // Optional offline host entry only. The host binds the owner recipient; this
  // does not prove a trusted host or wire a production consumer/scheduler.
  async function dispatchOwnerNotice(index) {
    if (arguments.length !== 1 || !nonNegative(index)) throw new TypeError('invalid notice index');
    if (ownerNoticeSender === undefined) return { status: 'not_configured' };
    if (mode === 'disabled' || currentEpoch() === null) return { status: 'not_eligible' };
    return dispatchNotice(store, index, {
      token: randomUUID(),
      sender: async (message, senderOptions) => {
        if (currentEpoch() === null) return 'unknown';
        const outcome = await ownerNoticeSender(message, senderOptions);
        // Delivery may already have happened: never reopen retry as failure.
        return currentEpoch() === null ? 'unknown' : outcome;
      },
    });
  }

  function status() {
    const epoch = currentEpoch();
    return Object.freeze({
      mode,
      connected: epoch !== null,
      // ── t43: `read_comments` is wired for PLAIN comment pages regardless of `exceptionReads`. ──
      // It used to be reported only when the host supplied `fetchCommentPage`, which no host does,
      // so the report said `['read_posts']` while the gate had already been opened for the comment
      // read. Reporting a tool as unwired AFTER making it work is worse than either state alone:
      // an operator reading this would go looking for a missing adapter that is no longer needed.
      // `fetchCommentPage` still governs the REPLY-EVIDENCE path (`own-new-comment`), which the
      // reader refuses on its own when the adapter is absent — that is a scope-level fact, not a
      // tool-level one, which is why it no longer appears here.
      wiredTools: Object.freeze(['read_posts', 'read_comments']),
    });
  }

  return Object.freeze({ dispatch, status, runHealthProbe, dispatchOwnerNotice });
}
