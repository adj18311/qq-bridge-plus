// qzone-safe DSH plugin entry. Default closed: without an explicit
// config.enabled === true it registers no tools and subscribes to no events.
// Effects (tools, subscriptions) only exist when the entry is enabled; dispatch
// exists only when an injected runtime provides dispatch and an epoch.
import { applyQzoneNativeTools } from './native-tool.mjs';
import { createQzoneImageLoader } from './post-images.mjs';
// SSRF-guarded fetcher: the ONLY way this plugin downloads a URL that another QQ account wrote.
import { safeFetchBuffer } from '../../src/safe-fetch.js';
import { createQzonePrestepAdapter } from './prestep-adapter.mjs';
import { createQzoneSessionObserver } from './session-observer.mjs';
import { createQzoneOriginLedger } from '../../src/core/qzone-origin-ledger-offline.mjs';
import { QZONE_MCP_TOOLS } from '../../src/core/qzone-mcp-contract.mjs';
import { createQzoneHostAssembly } from './host-assembly.mjs';
import {
  createHandleRegisterAdapter,
  createQzoneSourceRegisterListener,
  readSourceRegisterListenerConfig,
} from './source-register-listener.mjs';

export const name = 'qzone-safe';
export const inject = Object.freeze(['tools']);

export const STATES = Object.freeze({
  DISABLED: 'disabled',
  AWAITING_RUNTIME: 'enabled-awaiting-runtime',
  DISPATCH_READY: 'enabled-dispatch-ready',
  TOOLS_FAILED: 'tool-registration-failed',
  SUBSCRIPTION_FAILED: 'subscription-failed',
  DISPOSED: 'disposed',
});

export const MAX_POSITIONS = 4096;
const MAX_SESSIONS = 4096;
const MAX_AGENTS = 4096;
const TOOL_COUNT = Object.keys(QZONE_MCP_TOOLS).length;
// Every native tool this plugin registers is named `qzone_<action>`
// (`native-tool.mjs:55`). Kept as a Set so the adapter can answer membership in O(1).
const QZONE_TOOL_NAMES = new Set(Object.keys(QZONE_MCP_TOOLS).map((action) => `qzone_${action}`));
export { QZONE_TOOL_NAMES };
const validEpoch = (value) => typeof value === 'string' && value.length > 0;

/**
 * The CLOSED set of reasons `dispatchBound` can refuse for (t9).
 *
 * WHY THIS EXISTS: all five early exits return the same `origin-unbound` to the caller, which is
 * correct — the model must not learn which internal gate refused — but it left the FAILURE
 * undiagnosable from outside: after a restart, `{ok:false,error:'origin-unbound'}` could mean the
 * plugin never saw the event, saw it and dropped it, lost its ledger, or had a stale epoch, and no
 * surface could tell them apart. This array is the whole vocabulary; nothing else may be recorded.
 *
 * FROZEN AND CLOSED ON PURPOSE: a diagnostic that can grow a new string at runtime is a diagnostic
 * whose meanings drift. Every value is a fixed identifier — no session id, call id, QQ number,
 * token, body or timestamp is ever stored (see `dispatchRefusalFacts`).
 */
export const DISPATCH_REFUSAL_REASONS = Object.freeze([
  'invalid-context',   // 1. context.sessionId / context.callId is not a string
  'epoch',             // 2. ensureGenerationCurrent() was false (superseded generation)
  'position',          // 3. no `positions` entry for this (session, callId)
  'ledger',            // 4. no `ledgers` entry for this session
  'consume',           // 5. ledger.consume() returned a falsy binding
]);

/**
 * Attach the plugin to a DSH Cordis context.
 * @param ctx - agent-capable Cordis context (needs `tools` and `on`).
 * @param config - plugin config; only `enabled === true` activates anything. `config.assembly` is
 *   read by `apply()` (never here) and only when the host injected no runtime factory.
 * @param runtime - optional injected runtime `{ dispatch, epoch, defineTool }`.
 * @returns handle with `status()`, `registerBridgeRequest(sessionId, input)`, `dispose()`.
 */
export async function createQzonePluginHandle(ctx, config, runtime) {
  const enabled = config?.enabled === true;
  const ready = enabled && typeof runtime?.dispatch === 'function' && validEpoch(runtime?.epoch);
  const epoch = ready ? runtime.epoch : null;

  let state = enabled ? STATES.AWAITING_RUNTIME : STATES.DISABLED;
  let tools = 0;
  let subscriptions = 0;
  let disposed = false;
  let nativeHandle = null;
  const disposers = [];
  const adapters = new Map();
  const ledgers = new Map();
  const positions = new Map();
  // One `session/event` observer per SESSION, shared by every agent on that session.
  //
  // `session/event` is HOST-scoped, so a per-agent subscription records the same
  // `tool/call` and the same `turn/end` once per agent. With two agents on one session
  // that is double bookkeeping against ONE ledger: the second `observeToolCall` poisons
  // the callId (`spentCalls`), the second `endTurn` returns false and faults the shared
  // ledger, and the session is permanently dead while `status()` still promises.
  // Splitting the observation out (here, per session) instead of per agent is the fix;
  // dropping "later" events by key would NOT be a fix — a genuinely replayed host event
  // must still be caught by the ledger's replay protection.
  const observers = new Map();
  // `adapters` maps agentId -> { adapter, sessionId, dead }. The session is kept
  // alongside the adapter because `dispatchAvailable` must be answerable PER SESSION:
  // an adapter bound to s2 says nothing about whether a call from s1 can bind, and
  // reporting a global "some adapter exists" made `status()` promise true for
  // sessions that could not possibly dispatch.
  //
  // `dead` is latched by the adapter's `onDisconnected` callback. A runtime disconnect
  // (`prestep-adapter.mjs` on a malformed payload, a failed `endTurn`, or a
  // `observeStep` throw) latches `continuityLost` on the ledger, after which
  // `ledger.consume` and `ledger.peekCall` refuse everything. The adapter entry stays
  // in the map because only `agent/disposed` removes it, so without this flag the
  // plugin kept advertising a dispatchable session that could never dispatch.
  let adaptersDisconnected = 0;
  // Counts capacity evictions that had to sacrifice a STILL-consumable position
  // because every entry was alive. Zero in normal operation; a non-zero value is
  // the only observable evidence that a legitimate pending call was dropped.
  let positionsEvictedLive = 0;
  let stepsRefused = 0;
  // Adapter construction failures were swallowed by a bare `catch {}`. After this
  // change a failed construction still cannot be retried (the agent is already
  // created), but it is no longer invisible: `status()` reports how many agents
  // got no adapter, which otherwise reads as "space calls simply never happen".
  let adaptersFailed = 0;
  // Agents refused an adapter because their session's ledger was already dead
  // (`continuityLost` latched by a runtime fault, not by a clean dispose). Kept
  // separate from `adaptersFailed` on purpose: the cause and the remedy differ — a
  // construction failure is a bug in this plugin, while this one means the session's
  // ordering evidence was destroyed and only a rebuild can restore it.
  let adaptersBlocked = 0;

  // ── DIAGNOSTICS: which of the five `origin-unbound` exits actually fired (t9) ─────────────
  //
  // OBSERVATION ONLY. Nothing here changes a return value, a branch or a retry: every early exit
  // below still answers the exact same `{ ok: false, error: 'origin-unbound' }` it answered before,
  // and the counters are written on the way past. The reason vocabulary is the frozen
  // `DISPATCH_REFUSAL_REASONS` array; the counters are keyed by those same strings and by nothing
  // else, so a typo cannot create a sixth bucket.
  const dispatchRefusals = Object.create(null);
  for (const reason of DISPATCH_REFUSAL_REASONS) dispatchRefusals[reason] = 0;
  // The LAST refusal, as a reason string — not a history, not a timestamp, and never the ids that
  // produced it. `null` means "no refusal has happened since this handle was built", which is a
  // different statement from "nothing was ever dispatched".
  let lastDispatchRefusal = null;

  /**
   * Record one refusal reason and return the canonical refusal object.
   *
   * The return value is built here — rather than repeated at each exit — so the five branches
   * cannot drift apart in what the caller sees. It is byte-identical to what each branch used to
   * return inline.
   *
   * @param {string} reason one of `DISPATCH_REFUSAL_REASONS`.
   */
  const refuseDispatch = (reason) => {
    if (Object.hasOwn(dispatchRefusals, reason)) {
      dispatchRefusals[reason] += 1;
      lastDispatchRefusal = reason;
    }
    return { ok: false, error: 'origin-unbound' };
  };

  // ── DIAGNOSTICS: the `position` branch, split into its two real causes (t9) ────────────────
  //
  // "No position" means one of two very different things, and telling them apart is the whole
  // point: either the host's `session/event` never reached this plugin (subscription/timing), or
  // it arrived and this plugin declined to store it (filtered by tool NAME, filtered by ID shape,
  // or evicted). These are counts of EVENTS, not identifiers — no session id, call id, QQ number,
  // token or body is retained anywhere.
  let toolCallEventsSeen = 0;
  let positionsStored = 0;
  let positionsSkippedForeignTool = 0;
  let positionsSkippedInvalidId = 0;

  /**
   * The status surface, as a plain function so BOTH `status()` and the diagnosis snapshot read
   * the SAME implementation (t10). Duplicating the field list would let the tool report a
   * different truth than the handle — the exact failure mode a diagnostic must not have.
   *
   * WHY A `function` AND NOT AN ARROW: `arguments.length` distinguishes `status()` from
   * `status(undefined)` (see the note at `exact` inside). An arrow has no `arguments`.
   */
  function statusSnapshot(sessionId) {
    // Everything that is true regardless of which session asks.
    const surfaceReady = ready && state === STATES.DISPATCH_READY
      && !staleGenerationObserved && generationIsCurrent();
    // ONE evaluation feeds every session-shaped field below. Deriving
    // `dispatchableSessions` from a second pass over `adapters` let a single
    // snapshot contradict itself: right after a rotate, `dispatchAvailable` already
    // read false while `dispatchableSessions` still listed the retired session. A
    // caller that trusts the list would believe it could dispatch.
    const liveSessions = surfaceReady ? liveAdapterSessions() : new Set();
    // "Omitted" and "explicitly given" are different questions, and only the call
    // itself can tell them apart: `status()` asks "is ANY session wired" while
    // `status(anything)` names a session and must be answered for that value alone.
    //
    // Testing the parameter's TYPE cannot express that. `null`/`''`/`undefined` are
    // not "no session requested", they are "a session was requested and the caller
    // could not name it" — answering those with "some OTHER session can dispatch" is
    // precisely the false promise this field exists to remove. `arguments.length`
    // is the only signal that distinguishes `status()` from `status(undefined)`; a
    // default parameter or an `=== undefined` test silently collapses the two.
    const exact = arguments.length > 0;
    return Object.freeze({
      enabled,
      state,
      tools,
      subscriptions,
      // True only for a real same-process dispatch binding: the injected
      // runtime supplied both dispatch and an epoch (ready) AND tool
      // registration actually completed (state === DISPATCH_READY) AND the
      // cached ledgers are still bound to the live generation.
      //
      // The generation check is what makes this honest after a reconnect. The
      // retired-epoch ledgers are purged when a mismatch is detected, and this
      // probe is read-only so reporting status cannot itself mutate state — it
      // reports false and leaves the purge to the next real call.
      //
      // `ready` alone is not enough to promise that a tool call issued NOW would
      // dispatch. Dispatch goes through `dispatchBound`, which needs an entry in
      // `positions`, which only `observeToolCall` writes, which only the pre-step
      // adapter created in `agent/created` calls. A handle that has never seen that
      // event therefore has zero adapters and every call fails `origin-unbound`,
      // even though `ready`, `state` and `generationBound` all look healthy — the
      // worst shape, because the failure blames an unbound origin instead of the
      // missing binding. Reporting false here is the only honest answer; the host
      // has to create an agent (or the caller has to rebuild), which is a decision
      // this field must surface rather than hide.
      //
      // The adapter must also be ALIVE. `disconnect()` latches `continuityLost` on
      // the ledger and the entry stays in `adapters` until `agent/disposed`, so a
      // dead adapter used to keep this field true while `ledger.consume` refused.
      dispatchAvailable: exact
        ? surfaceReady && liveSessions.has(sessionId)
        : surfaceReady && liveSessions.size > 0,
      // Exact set of sessions with a LIVE adapter. Empty while `state` is still
      // `enabled-dispatch-ready` means "registered, but nothing can bind".
      dispatchableSessions: Object.freeze([...liveSessions]),
      // Total adapters bound (live + dead). Kept for continuity; does not answer
      // "can my session dispatch" — use `dispatchAvailable`/`dispatchableSessions`.
      agentAdapters: adapters.size,
      // Dead adapters whose ledger was disconnected at runtime. Non-zero means an
      // adapter is still in the map but can never consume: before this counter
      // existed that state was invisible (capacity eviction had
      // `positionsEvictedLive`, construction failure had `adaptersFailed`).
      adaptersDisconnected,
      // These two fields must share one source. `dispatchAvailable` folds in
      // `staleGenerationObserved` while a bare `generationIsCurrent()` does not, so an
      // injected lifetime that ever reported an older epoch back produced
      // {generationBound:true, staleGenerationObserved:true, dispatchAvailable:false}.
      // The real lifetime never goes backwards (rotate() always mints a new UUID), but
      // the latch is permanent, so keep them consistent anyway.
      generationBound: generationIsCurrent() && !staleGenerationObserved,
      staleGenerationObserved,
      // Non-zero means capacity eviction had to drop a position that was still
      // consumable: a legitimate pending call was sacrificed. The plugin has no
      // audit writer on that path, so this counter is the only surface that
      // makes the loss visible instead of silent.
      positionsEvictedLive,
      stepsRefused,
      adaptersFailed,
      // Agents refused a ledger that was already dead at creation time. Separate
      // from `adaptersFailed`: this one means the session's ordering evidence was
      // destroyed by an earlier runtime fault and only a rebuild restores it.
      adaptersBlocked,
      // ── DIAGNOSTICS (t9) ──────────────────────────────────────────────────────────────
      //
      // WHY A NEW FIELD AND NOT AN EXISTING ONE: this was checked field by field, and none of
      // the surfaces above can separate the five `origin-unbound` exits.
      //   · `staleGenerationObserved` is a PERMANENT latch that only covers exit 2 (`epoch`);
      //     it says nothing about the other four, and it cannot distinguish a stale epoch from
      //     a missing position.
      //   · `positionsEvictedLive` counts only capacity evictions of still-consumable entries;
      //     it stays 0 for a foreign tool name, an ID filter, or an event that never arrived.
      //   · `adaptersFailed` / `adaptersBlocked` / `adaptersDisconnected` describe ADAPTER
      //     construction — a different failure than "no position for this call".
      //   · `stepsRefused` counts refused PRE-STEP observations (ledger ordering), not tool calls.
      //   · `dispatchAvailable` / `dispatchableSessions` answer "could SOME call dispatch", never
      //     "why did THIS one not". Both were healthy in the reproduced incident.
      // So one closed-vocabulary field is added; it carries no identifier of any kind.
      lastDispatchRefusal: Object.freeze({
        reason: lastDispatchRefusal,
        counters: Object.freeze({ ...dispatchRefusals }),
      }),
      // The `position` branch, split into its two real causes. These counters let an operator
      // tell "the host never delivered the event" from "we received it and did not store it".
      // COUNTS ONLY — no session id, call id, QQ number, token, body or timestamp.
      positionStream: Object.freeze({
        toolCallEventsSeen,
        positionsStored,
        positionsSkippedForeignTool,
        positionsSkippedInvalidId,
        // Reused, not duplicated: the same counter the eviction path already increments.
        positionsEvictedLive,
        // Live size of the map at read time, so "stored N" can be compared with "still there".
        // A NUMBER, not a list: the keys are (session, callId) pairs and must never leak.
        positionsLive: positions.size,
      }),
    });
  }
  /**
   * Project the diagnosis snapshot the `qzone_diagnose` tool returns (t10).
   *
   * ALLOWLIST, NOT A COPY. It re-uses the SAME facts `status()` computes — the shared
   * `statusSnapshot` above, so the tool and the handle can never disagree — and keeps only the
   * non-identifying ones. That is not a cosmetic filter: `status()` legitimately carries session
   * ids in `dispatchableSessions`, and a tool whose answer goes to a model must never carry them.
   * Written as an explicit field list on purpose, so a future `status()` field is NOT silently
   * exposed here.
   *
   * FROZEN. A mutable answer could be rewritten by whoever holds it, and the whole value of a
   * diagnostic is that it says what was true when it was read.
   */
  /**
   * Whether the PICTURE path was assembled. Declared HERE, above the diagnostic that reports it,
   * and set once further down where the loader is built — the two sites must not disagree, so
   * there is exactly one writer.
   */
  let imageAttachmentsReady = false;

  const createQzoneDiagnoseSnapshot = () => {
    // The SAME function `status()` exposes — one implementation, two callers.
    const current = statusSnapshot();
    return Object.freeze({
      state: current.state,
      ready,
      dispatchAvailable: current.dispatchAvailable,
      // ⚠️ `status().dispatchableSessions` is a LIST OF SESSION IDS, and this task requires the
      // diagnostic answer to carry no sessionId. Those two requirements cannot both hold, so the
      // identifier ban wins — it is the hard one, and this answer is read by a model. The same
      // fact is exposed as a COUNT: "how many sessions could dispatch" answers the operational
      // question without naming any of them.
      dispatchableSessionCount: current.dispatchableSessions.length,
      // C9 facts, forwarded as-is (already frozen, already identifier-free).
      lastDispatchRefusal: current.lastDispatchRefusal,
      positionStream: current.positionStream,
      // Adapter / ordering counters an operator needs to read the above.
      agentAdapters: current.agentAdapters,
      adaptersFailed: current.adaptersFailed,
      adaptersBlocked: current.adaptersBlocked,
      adaptersDisconnected: current.adaptersDisconnected,
      stepsRefused: current.stepsRefused,
      // Generation binding: the epoch branch of `dispatchBound` is invisible without this.
      generationBound: current.generationBound,
      staleGenerationObserved: current.staleGenerationObserved,
      tools: current.tools,
      subscriptions: current.subscriptions,
      // M3: whether the PICTURE path is live. It is built ONCE, at assembly time, from an optional
      // host service (`ctx.get('attachments')`); without it `qzone_read_posts` returns text only.
      // Cordis `ctx.get` is a snapshot, so a service that appears later is NOT picked up — which
      // makes "no pictures" otherwise indistinguishable from "the service was not there yet".
      // Boolean only: no service name, no id, no path.
      imageAttachments: imageAttachmentsReady === true,
      // C13: can the bridge actually REGISTER an inbound source with this plugin? A dispatch that
      // fails at `consume` because the ledger's `requests` is empty is invisible without this: the
      // ledger looks healthy while the listener may never have bound its port.
      //
      // WHY HERE AND NOT IN `status()`: `status()`'s shape is pinned field-by-field by
      // `scripts/test-qzone-dispatch-status.mjs`, which this task must not touch. The diagnostic
      // snapshot is the purpose-built place for exactly this kind of operational fact.
      // 'not-managed' means the handle was built by a host that never asked `apply()` to run the
      // listener — the state then belongs entirely outside this plugin.
      sourceRegister: Object.freeze({ ...(runtime?.sourceRegisterStatus ?? { state: 'not-managed' }) }),
    });
  };

  const subscribe = (event, listener) => {
    const dispose = ctx.on(event, listener);
    if (typeof dispose !== 'function') throw new TypeError(`qzone-safe subscription ${event} is not disposable`);
    subscriptions += 1;
    disposers.push(dispose);
  };

  // A generation change retroactively invalidates every cached ledger, so the
  // comparison has to run on EVERY lookup, not only when the cache is cold.
  //
  // The cache is filled on first use and then kept. Comparing `sourceEpoch()` only
  // inside the `if (!ledger)` branch meant that after a reconnect
  // (`qzone-connection-source-coordinator-offline.mjs` calls `sources.rotate()` on
  // every open/close/error) every cached ledger stayed bound to the RETIRED
  // generation: `registerBridgeRequest` threw "来源账本不可用或已满",
  // `dispatchBound` returned `origin-unbound`, nothing was audited, and `status()`
  // still said dispatch-ready. The whole space-tool surface went silently dead
  // after one reconnect, with no way to notice and no path to recover.
  //
  // Purge-on-mismatch is the only correct response: entries bound to a retired
  // epoch can never authenticate again (the runtime would reject them), so keeping
  // them would only strand the plugin. Callers must then build a NEW runtime and
  // handle for the new generation — this entry cannot re-home itself.
  let staleGenerationObserved = false;
  const purgeRetiredGeneration = () => {
    for (const ledger of ledgers.values()) {
      try { ledger.disconnect(); } catch {}
    }
    ledgers.clear();
    positions.clear();
  };
  // Read-only probe: no mutation, so `status()` can call it.
  const generationIsCurrent = () => {
    if (!runtime?.sourceLifetime) return true;
    let live;
    try { live = runtime.sourceLifetime.sourceEpoch(); } catch { live = null; }
    return live === epoch;
  };
  // Destructive variant used on the paths that need a usable ledger.
  const ensureGenerationCurrent = () => {
    if (generationIsCurrent()) return true;
    staleGenerationObserved = true;
    purgeRetiredGeneration();
    return false;
  };

  // A ledger can be dead while every other signal looks healthy: `disconnect()`
  // latches `continuityLost` for good, and the object itself is frozen so nothing can
  // clear it. `alive()` is the only honest way to ask.
  //
  // TWO judgements, deliberately different:
  //
  //   · `ledgerIsAlive` (lenient) is used on the CONSTRUCTION path. An older injected
  //     ledger without `alive()` is treated as alive, because refusing to wire on a
  //     missing method would turn a compatibility gap into an outage.
  //   · `strictLedgerIsAlive` (strict) decides whether a session may be ADVERTISED as
  //     dispatchable. Production contract: the injected ledger MUST implement
  //     `alive(): boolean`. Missing method ⇒ NOT dispatchable (fail-closed). Signing a
  //     production availability promise off a method that may not exist is exactly the
  //     leniency that produced the B7 false promise.
  const ledgerIsAlive = (ledger) => typeof ledger.alive !== 'function' || ledger.alive() === true;
  const strictLedgerIsAlive = (ledger) => {
    if (!ledger) return false;
    try {
      return typeof ledger.alive === 'function' && ledger.alive() === true;
    } catch {
      return false;
    }
  };
  // Same split for the observer. Production contract is `alive(): boolean`, and a
  // disposed observer is NOT alive — `session-observer.mjs` answers
  // `active && !disconnected`, so a torn-down observer can never keep a session listed.
  const strictObserverIsAlive = (observer) => {
    if (!observer) return false;
    try {
      return typeof observer.alive === 'function' && observer.alive() === true;
    } catch {
      return false;
    }
  };

  // Latch EVERY agent entry on a session dead. `disconnect()` latches `continuityLost`
  // on the ONE frozen ledger that all agents on the session share, so exactly one fault
  // makes the whole session undispatchable. Failing to propagate it would leave the
  // survivors' entries "alive" — `liveAdapterSessions()` would keep the session in
  // `dispatchableSessions` while `ledger.consume` refused every call, which is the same
  // false promise this surface exists to remove.
  //
  // The counter is bumped ONCE per fault, not once per entry: it counts faults, and one
  // fault is one fault no matter how many agents shared the session.
  const faultSession = (sessionId) => {
    let latched = false;
    for (const other of adapters.values()) {
      if (other.sessionId !== sessionId || other.dead) continue;
      other.dead = true;
      latched = true;
    }
    if (latched) adaptersDisconnected += 1;
  };

  const ledgerFor = (sessionId) => {
    if (!ensureGenerationCurrent()) throw new Error('来源代际不匹配');
    let ledger = ledgers.get(sessionId);
    if (!ledger) {
      if (ledgers.size >= MAX_SESSIONS) throw new Error('来源会话容量已满');
      if (runtime?.sourceLifetime) {
        ledger = runtime.sourceLifetime.getLedger(sessionId);
      } else {
        ledger = createQzoneOriginLedger({ sessionId, epoch });
      }
      ledgers.set(sessionId, ledger);
    }
    return ledger;
  };

  // Drop a session's cached ledger so the next lookup mints a fresh one. Only called
  // on a CLEAN session boundary (see `agent/disposed`): a ledger killed by a runtime
  // fault must stay cached and dead, because replacing it would clear
  // `usedRequests`/`spentCalls` and reopen a replay window across the fault.
  const releaseLedger = (sessionId) => {
    ledgers.delete(sessionId);
    try { runtime?.sourceLifetime?.invalidate?.(sessionId); } catch {}
  };

  // Dispatch only after the origin ledger has bound this exact tool call to a
  // bridge request. Missing position, mismatched session, or unbound call fails closed.
  //
  // `positions` is keyed by the PAIR (sessionId, callId), not by the bare callId
  // and not by a delimiter-joined string. A bare key lets one session's tool/call
  // overwrite — or, on the dispatch side, delete — another session's pending entry
  // when two hosts reuse the same callId.
  //
  // A joined string is not enough either: the session id charset is
  // `[A-Za-z0-9_.:-]` and the call id arrives from the host, so BOTH halves may
  // contain the delimiter. `a:b` + `c` and `a` + `b:c` then collapse to the same
  // `a:b:c` key and the second announcement steals the first one's position.
  // JSON.stringify of a two-element array is injective over strings, so no pair can
  // alias another. The value still carries `sessionId` for defence in depth, and
  // the entry is only removed after it has been matched to this exact session.
  const positionKeyOf = (sessionId, callId) => JSON.stringify([sessionId, callId]);
  // The announce path is the ONE place a callId reaches this plugin without passing
  // a gate: the native tool handler validates `exec.callId` through
  // `session-context.mjs` (`/^[A-Za-z0-9_.:-]{1,128}$/`) and the ledger caps both ids
  // at 128, but `session/event` is written by the host straight from the model's tool
  // block. An over-long id could therefore occupy a `positions` slot and be retained
  // until eviction — 4096 slots times an unbounded length is unbounded memory even
  // though the entry can never dispatch (the tool handler refuses it one hop later).
  // The same charset the downstream gates already require, applied here, drops
  // exactly the values that could never have dispatched.
  const POSITION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
  // Whether a position can still be consumed: its ledger must exist and still hold
  // a binding for that exact (turn, step). `peekCall` returns null once the entry
  // was consumed, reaped at `endTurn`, refused for capacity, or poisoned.
  //
  // The callId is passed in rather than read off the position value: the stored
  // value deliberately carries only `{ sessionId, turn, step }`, so reading
  // `position.callId` yields undefined, `peekCall(undefined)` returns null, and
  // every live position would look dead — the exact opposite of the intent.
  const positionIsDead = (callId, position) => {
    const ledger = ledgers.get(position.sessionId);
    if (!ledger) return true;
    try {
      const peek = ledger.peekCall(callId);
      return !peek || peek.turn !== position.turn || peek.step !== position.step;
    } catch {
      return true;
    }
  };
  const evictOnePosition = () => {
    for (const [key, position] of positions) {
      // The key is `JSON.stringify([sessionId, callId])`, so the callId is the
      // second element — the only place it survives, since the stored value keeps
      // just `{ sessionId, turn, step }`.
      const parsed = JSON.parse(key);
      if (positionIsDead(parsed[1], position)) {
        positions.delete(key);
        return;
      }
    }
    // Every entry is still consumable: fall back to the oldest, and say so.
    positions.delete(positions.keys().next().value);
    positionsEvictedLive += 1;
  };
  const dispatchBound = async (action, input, context) => {
    const sessionId = context?.sessionId;
    const callId = context?.callId;
    // OBSERVATION ONLY: each exit still returns the SAME object (via `refuseDispatch`), and the
    // reason recorded is the fixed vocabulary value for that branch. Nothing about authority,
    // ordering or retry changes.
    if (typeof sessionId !== 'string' || typeof callId !== 'string') return refuseDispatch('invalid-context');
    // A superseded generation must fail here, not one hop later: `runtime` still
    // holds the retired epoch, so letting the call through would surface a
    // confusing error from inside the runtime.
    if (!ensureGenerationCurrent()) return refuseDispatch('epoch');
    const positionKey = positionKeyOf(sessionId, callId);
    const position = positions.get(positionKey);
    if (!position || position.sessionId !== sessionId) return refuseDispatch('position');
    positions.delete(positionKey);
    const ledger = ledgers.get(sessionId);
    if (!ledger) return refuseDispatch('ledger');
    const binding = ledger.consume({ sessionId, callId, turn: position.turn, step: position.step });
    if (!binding) return refuseDispatch('consume');
    return runtime.dispatch(action, input, Object.freeze({ sessionId, callId, binding }));
  };

  // Sessions that currently have at least one LIVE adapter. An adapter whose ledger was
  // disconnected can never consume again (`continuityLost` is a latch), so counting it
  // as "wired" made `dispatchAvailable` promise success while every call failed
  // `origin-unbound`. Derived fresh on each call: no cached set to go stale.
  const liveAdapterSessions = () => {
    const sessions = new Set();
    for (const entry of adapters.values()) {
      if (entry.dead) continue;
      // B7 (Codex ruling 1): an entry being alive is NOT enough. `coordinator.invalidate(S)`
      // disconnects the ledger WITHOUT changing the epoch, so nothing above notices — the
      // session stayed in `dispatchableSessions` while `registerBridgeRequest` threw
      // 「来源账本不可用或已满」. The state has to be derived from the objects the plugin
      // ALREADY holds:
      //
      //   · the CACHED ledger in `ledgers` — `invalidate()` disconnects that very object,
      //     so `alive()` on the cached copy already reports false. Reading it creates
      //     nothing (calling `getLedger` here would mint a fresh ledger, i.e. mutate state
      //     from a getter, which this must never do).
      //   · the session's observer — a disposed observer no longer records events, so the
      //     session could not bind even with a live ledger.
      //
      // Any absence, deadness, or THROW from these probes means "not dispatchable". This
      // is read-only: no creation, no purge, no rotation, no counter bump.
      const ledger = ledgers.get(entry.sessionId);
      if (!strictLedgerIsAlive(ledger)) continue;
      const observer = observers.get(entry.sessionId);
      if (!strictObserverIsAlive(observer)) continue;
      sessions.add(entry.sessionId);
    }
    return sessions;
  };

  const teardown = async () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose(); } catch {}
    }
    // Tear down the per-session `session/event` observers BEFORE the ledgers below.
    //
    // These used to belong to the adapter, so `teardown()` reached them through the
    // adapter loop; once observation moved to session granularity they became a separate
    // Map that nothing on this path cleaned. Only `agent/disposed` disposed them, so
    // every reload that ended without a clean per-agent close left one host
    // `session/event` listener — plus its closure and the disconnected ledger it
    // captures — alive forever. `handle.dispose()` is the one boundary that must leave
    // the host exactly as it found it, no matter how the session ended.
    //
    // Order matters in one direction only: dispose them before `ledgers` is disconnected
    // (`session-observer.dispose()` does not touch the ledger, but keeping the
    // "stop observing, then retire the thing being observed" order means no callback can
    // land on a ledger mid-teardown even if that ever changes).
    for (const observer of observers.values()) {
      try { observer.dispose(); } catch {}
    }
    observers.clear();
    for (const entry of adapters.values()) {
      try { entry.adapter.dispose(); } catch {}
    }
    adapters.clear();
    for (const ledger of ledgers.values()) {
      try { ledger.disconnect(); } catch {}
    }
    ledgers.clear();
    positions.clear();
    if (nativeHandle) {
      try { nativeHandle.dispose(); } catch {}
      nativeHandle = null;
    }
    tools = 0;
    subscriptions = 0;
  };

  if (enabled) {
    try {
      if (ready) {
        subscribe('session/event', (session, event) => {
          if (disposed || event?.type !== 'tool/call') return;
          // DIAGNOSTIC (t9): count every `tool/call` that survives the BASE filter, i.e. that the
          // host really delivered one with a usable shape. Zero here means the event never reached
          // this plugin at all — the subscription-time question — which is a completely different
          // fix from "it arrived and we filtered it out". No identifier is stored.
          toolCallEventsSeen += 1;
          const callId = event.data?.callId;
          if (typeof callId !== 'string' || typeof session?.id !== 'string') {
            positionsSkippedInvalidId += 1;
            return;
          }
          // Reject here what could never dispatch: an over-long or out-of-charset id
          // is refused by `session-context.mjs` at the tool surface anyway, so storing
          // it would only let unauthenticated traffic occupy `positions` slots.
          if (!POSITION_ID.test(callId) || !POSITION_ID.test(session.id)) {
            positionsSkippedInvalidId += 1;
            return;
          }
          // A position is only ever consumed by a dispatch through a `qzone_*` tool
          // (`dispatchBound` is only reachable from the native tool handlers). DSH
          // emits one `tool/call` per invocation of ANY tool, so without this filter
          // 4096 ordinary calls push a pending space call out of the map and it fails
          // `origin-unbound` even though its ledger binding is valid. A name that is
          // ABSENT is still recorded: the host always writes it
          // (`dsh-tools/lib/pipeline.js:188`), and refusing nameless events here would
          // turn a host quirk into a silent dispatch failure.
          const toolName = event.data?.name;
          if (typeof toolName === 'string' && toolName && !QZONE_TOOL_NAMES.has(toolName)) {
            // Same filter, now counted: a name that is not a `qzone_*` tool is deliberately not
            // stored, so an all-non-qzone stream reaching this point is the signature of "events
            // arrive, positions never stored".
            positionsSkippedForeignTool += 1;
            return;
          }
          // Eviction loses only the oldest pending position; clearing the map
          // would invalidate every unrelated in-flight tool call at capacity.
          // The key is the (session, call) PAIR, so two hosts reusing one callId
          // coexist and no delimiter in either half can alias another pair.
          //
          // Prefer entries whose ledger binding is already gone. A position whose
          // `peekCall` returns null can never be consumed (`dispatchBound` would
          // fail closed in `ledger.consume`), so dropping it costs nothing, while
          // dropping a still-consumable one destroys a legitimate pending call —
          // it surfaces to the user as `origin-unbound`, produces no audit row
          // (the plugin has no audit writer on this path) and the natural retry
          // spends the callId for good. Only when every entry is still consumable
          // does the oldest one get dropped.
          const positionKey = positionKeyOf(session.id, callId);
          if (!positions.has(positionKey) && positions.size >= MAX_POSITIONS) {
            evictOnePosition();
          }
          positions.set(positionKey, Object.freeze({ sessionId: session.id, turn: event.data.turn, step: event.data.step }));
          // Counted AFTER the write, so "stored" is a fact about the map, not about intent.
          positionsStored += 1;
        });
        // ── THE ONE BINDING BODY, used by BOTH paths ────────────────────────────────────────
        //
        // WHY IT IS A NAMED FUNCTION AND NOT A CLOSURE INSIDE THE SUBSCRIBER (t8): the same work
        // has to run for an agent the host announces LATER and for an agent that ALREADY EXISTS
        // when this handle is built (see `adoptExistingAgents`). Two copies of this block would
        // drift — the observer rollback, the `ledgerIsAlive` refusal and the `installed` latch are
        // all easy to get subtly different on a second pass — so there is exactly one.
        //
        // IDEMPOTENT: `adapters.has(agent.id)` is the early exit both callers rely on, which is
        // what makes a late duplicate `agent/created` (or an adoption that raced the event) a
        // no-op instead of a second adapter on one agent.
        const bindAgent = (agent) => {
          const sessionId = agent?.session?.id;
          if (typeof agent?.id !== 'string' || typeof sessionId !== 'string' || adapters.has(agent.id)
              || adapters.size >= MAX_AGENTS) return false;
          // Declared OUTSIDE the `try`: the `catch` below must be able to roll back an
          // observer created by this attempt, and a `let` inside the block is scoped to it.
          let sessionObserver = null;
          let createdObserver = false;
          try {
            // The cached ledger may already be dead: `continuityLost` is a one-way
            // latch, and a runtime fault (not a clean dispose) deliberately keeps the
            // ledger in the cache so its replay records survive. Installing an adapter
            // on it would produce exactly the false promise this whole change removes:
            // `status()` true, every dispatch `origin-unbound`, nothing counted.
            // Refuse to wire, count it, and leave the session out of
            // `dispatchableSessions` — the host has to rebuild, which is a decision
            // this surface must expose rather than hide.
            const ledger = ledgerFor(sessionId);
            if (!ledgerIsAlive(ledger)) {
              adaptersBlocked += 1;
              return false;
            }

            // `installed` distinguishes a runtime disconnect from a construction
            // failure: the adapter's own failure path calls `disconnect()`, which
            // would otherwise bump `adaptersDisconnected` for an entry that never
            // entered the map — leaving a counter that points at nothing.
            const entry = { adapter: null, sessionId, dead: false };
            let installed = false;
            // The session-level observer is created on the FIRST agent of a session and
            // shared by the rest. It is the only subscriber that touches
            // `observeToolCall` / `endTurn`, so one host event is recorded once.
            //
            // Whether THIS attempt created the observer is kept in `createdObserver`
            // (declared outside the `try`) so the `catch` can roll back a fresh one
            // without touching an observer that other live agents on the session share.
            sessionObserver = observers.get(sessionId);
            if (!sessionObserver) {
              sessionObserver = createQzoneSessionObserver({
                eventContext: ctx, ledger, sessionId,
                // Only `qzone_*` calls can ever be dispatched (`dispatchBound` is
                // reachable solely from the native tool handlers), so observing every
                // other tool's `tool/call` only spends ledger capacity. DSH emits one
                // event per invocation of ANY tool, and `calls` is capped by
                // `trackingLimit`, so unfiltered traffic makes ordinary tool use
                // contend with space calls for the same budget.
                bindableToolNames: QZONE_TOOL_NAMES,
                // A fault here means ordering evidence was destroyed for the WHOLE
                // session: the observer's `disconnect()` already latched
                // `continuityLost` on the ONE ledger every agent on this session shares,
                // so every one of them is now unusable and the session must stop
                // advertising itself as dispatchable.
                onDisconnected: () => faultSession(sessionId),
              });
              observers.set(sessionId, sessionObserver);
              createdObserver = true;
            }
            entry.adapter = createQzonePrestepAdapter({
              agentContext: agent.ctx, ledger, sessionId,
              // A refused pre-step is the one observable symptom of a lost source
              // that the agent's own stream can see; surface the count instead of
              // letting the ledger go quiet while `status()` claims ready.
              onStepRefused: () => { stepsRefused += 1; },
              // A pre-step fault is agent-scoped input but a LEDGER-scoped consequence:
              // `prestep-adapter.mjs` calls `ledger.disconnect()`, and that is the same
              // frozen ledger every agent on this session shares. Latching only this
              // entry would leave the survivors "alive", so `status()` would keep the
              // session in `dispatchableSessions` while `ledger.consume` refused every
              // call — a false promise reached through one agent's malformed input
              // instead of a duplicate event.
              onDisconnected: () => {
                if (!installed) return;
                faultSession(sessionId);
              },
            });
            adapters.set(agent.id, entry);
            installed = true;
            return true;
          } catch {
            adaptersFailed += 1;
            // No agent got an adapter, so a session observer invented for it has no one
            // to serve: it would sit in the Map (and in the host's listener list) for a
            // session that can never dispatch. Roll back ONLY what this attempt created.
            // A shared observer stays — its other agents are still live.
            if (createdObserver) {
              observers.delete(sessionId);
              try { sessionObserver.dispose(); } catch {}
            }
            return false;
          }
        };

        subscribe('agent/created', (payload) => {
          if (disposed) return;
          bindAgent(payload?.agent);
        });

        subscribe('agent/disposed', (payload) => {
          const agent = payload?.agent;
          const entry = typeof agent?.id === 'string' ? adapters.get(agent.id) : undefined;
          if (!entry) return;
          adapters.delete(agent.id);
          try { entry.adapter.dispose(); } catch {}
          // A CLEAN session boundary releases the ledger so a later resume of the same
          // session mints a fresh one. `getLedger` hands the same frozen object back
          // forever, so without this release a close+resume left the session permanently
          // `origin-unbound` while `status()` reported ready — across plugin reloads, with
          // no count.
          //
          // CORRECTED 2026-11-11: this comment used to say `dispose()` disconnects the
          // ledger. It does not — it only unsubscribes the pre-step listener
          // (`prestep-adapter.mjs` dispose). That is exactly what lets the R-2 guard
          // below read `alive()` and distinguish a healthy exit from a revocation.
          //
          // Deliberately NOT done when `entry.dead` is set: that flag means a runtime
          // fault latched `continuityLost`, and the ledger's `usedRequests` /
          // `spentCalls` are the only replay protection left across that fault.
          // Replacing it there would reopen a replay window; the session stays blocked
          // and `adaptersBlocked` reports why.
          const stillUsed = [...adapters.values()].some((other) => other.sessionId === entry.sessionId);
          if (stillUsed) return;
          // Last agent on this session is gone, so the session observer has nobody left to
          // serve. This MUST happen for a faulted session too: the old `if (entry.dead)
          // return` short-circuited before this cleanup, so a session that faulted and
          // then closed cleanly kept its observer (plus the host listener and the dead
          // ledger it captures) for the life of the host. Observed as a monotonic
          // `session/event` listener growth of one per reload on the fault path.
          //
          // Disposing the observer is safe on a dead ledger: `session-observer.dispose()`
          // only unsubscribes and does not touch `ledger.disconnect()`, and the ledger is
          // already latched `continuityLost` so no recording can happen anyway.
          //
          // Dropped BEFORE the ledger so no event can arrive on an observer whose ledger
          // is being replaced (see `releaseLedger` below).
          const observer = observers.get(entry.sessionId);
          if (observer) {
            observers.delete(entry.sessionId);
            try { observer.dispose(); } catch {}
          }
          // Faulted sessions STOP HERE on purpose: the ledger is kept, never replaced.
          // `spentCalls` / `usedRequests` are the only replay protection that survives the
          // fault, and minting a fresh ledger would reopen the replay window. The observer
          // is cleaned above; the ledger is not.
          if (entry.dead) return;
          // R-2 (Codex ruling 1 / handoff §1): an EXTERNAL revocation must not be healed by
          // a clean exit. The two cases ARE distinguishable at this exact point — measured,
          // not assumed:
          //
          //   healthy clean exit -> the cached ledger is STILL ALIVE. `adapter.dispose()
          //     only unsubscribes the pre-step listener; it never disconnects the ledger.
          //     Releasing it here is what makes a legitimate rebuild work (R-1).
          //   external revoke    -> the cached ledger is ALREADY DEAD while entry.dead is
          //     unset, because nothing inside this plugin faulted it (lifetime.invalidate
          //     disconnects the same frozen object without touching the generation).
          //
          // Releasing a ledger that was killed from outside would mint a fresh one and
          // reopen the replay window, so that session stays blocked. The refusal becomes
          // observable at the next `agent/created, which hits the dead ledger and bumps
          // `adaptersBlocked — not here, where no agent is being refused an adapter.
          {
            const cachedLedger = ledgers.get(entry.sessionId);
            if (cachedLedger !== undefined && !strictLedgerIsAlive(cachedLedger)) return;
          }
          releaseLedger(entry.sessionId);
        });

        /**
         * Bind every agent the host ALREADY has, using the SAME body the event path uses.
         *
         * ── WHY THIS EXISTS (t8) ──────────────────────────────────────────────────────────────
         * `apply()` awaits the runtime build and only THEN constructs this handle, so the
         * `agent/created` / `session/event` subscriptions above are installed LATE. DSH restores
         * its existing sessions immediately on restart — inside that window — so the events are
         * emitted before anyone is listening and are gone forever. No adapter ⇒ no ledger entry ⇒
         * no `positions` entry ⇒ every `qzone_*` call answers `origin-unbound` while `ready`,
         * `state` and `generationBound` all look healthy.
         *
         * ⚠️ THIS IS AN ADOPTION, NOT A RECONSTRUCTION. It only establishes FUTURE observation
         * for an agent the host already has: it installs the pre-step adapter and the session
         * observer, so the NEXT real `agent/pre-step` / `session/event` reaches the ledger.
         *   · it does NOT fabricate past turn/step positions;
         *   · it does NOT consume any ticket or branded consumption;
         *   · it does NOT authorise, whitelist or release any existing request;
         *   · it does NOT turn a call this plugin never observed into a dispatchable one.
         * A call whose events were lost stays `origin-unbound`, which is the correct answer: there
         * is no ordering evidence for it, and inventing some is exactly what this file must never
         * do. See `test-qzone-plugin-adopt-existing.mjs` AD-1, which pins BOTH directions — a new
         * observed call dispatches, and a call from before the adoption does not.
         *
         * WHY AFTER THE SUBSCRIPTIONS AND NOT BEFORE: adoption covers the agents that exist NOW;
         * the subscriptions cover the ones that appear a moment later. The other order leaves a
         * gap — an agent created between the sweep and the `subscribe` call is announced to
         * nobody. With this order there is no gap: anything created before the sweep is adopted,
         * anything after it is announced, and `bindAgent` is idempotent so the overlap is harmless.
         *
         * WHY `ctx.get?.('agents')` AND NOT AN `inject` ENTRY: adding `agents` to `inject` would
         * make this plugin refuse to load on every host that does not provide it, turning a
         * best-effort repair into a hard dependency. It is an OPTIONAL query — a host without the
         * service still loads and simply keeps the pre-t8 behaviour.
         *
         * FAILURE POLICY: silent. A missing service, a `get` that throws, a `list()` that throws
         * or answers a non-array, and a `bindAgent` that throws are all swallowed — plugin load is
         * never aborted by a repair, and no counter is added for it: the existing surfaces
         * (`agentAdapters`, `adaptersFailed`, `dispatchableSessions`) already describe the result,
         * and a second set of numbers to keep in step would be redundant telemetry.
         */
        const adoptExistingAgents = () => {
          let service;
          try {
            service = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
          } catch {
            return;
          }
          if (service === undefined || service === null) return;
          let list;
          try {
            list = typeof service.list === 'function' ? service.list() : undefined;
          } catch {
            return;
          }
          if (!Array.isArray(list)) return;
          for (const agent of list) {
            if (disposed) return;
            try {
              // The SAME binding body the event path uses — never a second copy of it.
              bindAgent(agent);
            } catch {
              // A hostile or unreadable agent simply gets no adapter, exactly as it would have
              // without the sweep.
            }
          }
        };
        adoptExistingAgents();
      }
    } catch {
      await teardown();
      state = STATES.SUBSCRIPTION_FAILED;
    }

    if (state === STATES.AWAITING_RUNTIME) {
      // ── t32: the image-attachment dependency for `qzone_read_posts` ────────────────────────
      //
      // A model cannot fetch a URL, so pictures in a space post reach it only if SOMEONE loads
      // them and hands them over as attachments. That someone is the host, via its attachment
      // service. The plugin does not create the service and does not guess at it:
      //
      //   · `ctx.get('attachments')` is queried OPTIONALLY, exactly like `ctx.get('agents')` above,
      //     and for the same reason — adding it to `inject` would make the plugin refuse to load on
      //     every host that does not provide it. A missing service is not an error: the tool keeps
      //     returning TEXT ONLY, which is the pre-t32 behaviour, byte for byte.
      //   · the fetch is `globalThis.fetch` or nothing. There is no bespoke HTTP client here: the
      //     download must go through the host's own network stack so it inherits whatever policy
      //     that stack applies.
      //   · ANY failure to build the loader degrades to text. Pictures are an enhancement.
      let imageLoader;
      try {
        const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined;
        if (attachments !== undefined && attachments !== null
            && typeof attachments.saveImage === 'function') {
          imageLoader = createQzoneImageLoader({
            attachments,
            // safeFetchBuffer, NOT a bare fetch. The URLs come from post content written by
            // another QQ account; that account must not be able to point this process at
            // 127.0.0.1, 169.254.169.254 or a LAN address and read the response back through the
            // model. safe-fetch refuses private/link-local/loopback targets, re-validates every
            // redirect, and enforces the byte cap. `allowRedirect: false` is deliberate: a post
            // picture is served directly, so a redirect is a signal, not a detour to follow.
            // The host may substitute its own downloader. Production passes none and gets
            // safeFetchBuffer; a test passes a fake so no socket is opened. This is the only
            // injection point for the download, and it cannot be reached from a model argument.
            downloadImage: typeof runtime?.imageDownloader === 'function'
              ? runtime.imageDownloader
              : async (url, { signal, maxBytes }) => {
                const result = await safeFetchBuffer(url, maxBytes, { signal, allowRedirect: false });
                return result.buffer;
              },
          });
        }
      } catch {
        imageLoader = undefined;
      }
      imageAttachmentsReady = imageLoader !== undefined;
      const result = await applyQzoneNativeTools(ctx, {
        dispatch: ready ? dispatchBound : undefined,
        defineTool: typeof runtime?.defineTool === 'function' ? runtime.defineTool : undefined,
        // The READ-ONLY diagnostic surface. `status()` is already the honest view of this handle;
        // the projector around it (see `createQzoneDiagnoseSnapshot`) strips the session ids the
        // model must not receive. It is passed unconditionally so the tool is always available when
        // a handle exists — an operator who needs it is, by definition, in a broken state.
        diagnose: createQzoneDiagnoseSnapshot,
        // Omitted entirely when the host offers no attachment service: `native-tool.mjs` then has
        // no image path at all and cannot open a network connection even by mistake.
        ...(imageLoader === undefined ? {} : { imageLoader }),
      });
      if (result?.ok === true) {
        nativeHandle = result;
        tools = TOOL_COUNT;
        state = ready ? STATES.DISPATCH_READY : STATES.AWAITING_RUNTIME;
      } else {
        await teardown();
        state = STATES.TOOLS_FAILED;
      }
    }
  }

  return Object.freeze({
    name,
    // `sessionId` is optional. Call it with the session you intend to call from and the
    // answer is exact for that value — including when the value is `null`, `''` or an
    // explicit `undefined`, which all mean "I do not know which session I am" and are
    // therefore NOT answered with "some other session is wired". Omit the argument
    // entirely and the answer means "at least one session is wired".
    //
    // A single boolean cannot be honest for a handle that serves several sessions: an
    // adapter bound to s2 says nothing about s1, and the previous global
    // `adapters.size > 0` reported `dispatchAvailable: true` for a then-`s1` call that
    // could only ever fail `origin-unbound`. `dispatchableSessions` carries the exact
    // set so a caller that does not know its session can still discriminate.
    status: statusSnapshot,
    // The READ-ONLY diagnosis snapshot, exposed for hosts that want to ask the handle directly
    // (the `qzone_diagnose` tool is registered from the same function). Identical to what the tool
    // returns: an allowlist projection, frozen, with no session id, call id, QQ number, token or
    // body — see `createQzoneDiagnoseSnapshot`.
    diagnose: () => createQzoneDiagnoseSnapshot(),
    registerBridgeRequest(sessionId, input) {
      if (state !== STATES.DISPATCH_READY) throw new TypeError('qzone-safe runtime not ready');
      return ledgerFor(sessionId).registerBridgeRequest(input);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await teardown();
      state = STATES.DISPOSED;
    },
  });
}

// ── OPTIONAL HOST-RUNTIME INJECTION — the one seam between this plugin and a real host ─────
//
// `createQzonePluginHandle` has always accepted a runtime as its third argument; nothing ever
// SUPPLIED one, so an enabled plugin stayed in `enabled-awaiting-runtime` forever and every tool
// answered `dispatch-unavailable`. A host can now hand this plugin a FACTORY on its Cordis
// context, and `apply` builds the runtime from it. The factory is the only thing read from the
// host; this module still builds no store, transport, clock or approval policy.
//
// WHY A FACTORY AND NOT A BUILT OBJECT: the object that comes back is the one this plugin hands
// to the handle, so `apply`'s disposer must be able to retire it. A factory makes that ownership
// explicit — whatever it returns is torn down here (`runtime.teardown()`), and something the host
// built and kept for itself is therefore never disposed behind its back.
//
// WHAT IS DELIBERATELY NOT DONE HERE:
//   · `enabled !== true` ⇒ the factory is NOT read and NOT called (the previous behaviour, byte
//     for byte: no runtime, `ready = false`, `dispatch-unavailable`);
//   · an ABSENT factory ⇒ exactly the previous behaviour (no default, no invented runtime);
//   · a factory that is present but not callable, or that answers something this plugin cannot
//     dispatch over (no `dispatch`, or a missing/empty `epoch`), is a TypeError — an injected
//     dependency that cannot work must fail loudly instead of leaving a half-ready handle.
//
// READING `ctx` IS GUARDED ON PURPOSE: a Cordis context THROWS for a service it was not injected
// with, and that is the ordinary 'nothing was injected' case here, not an error.
const RUNTIME_FACTORY = 'qzonePluginRuntimeFactory';

// ── C13: THE SOURCE-REGISTRATION LISTENER ───────────────────────────────────────────────────
//
// The ledger only honours a requestId it has been TOLD about (`registerBridgeRequest`). That call
// lived entirely inside this process, while the id is minted in the bridge — so in production the
// ledger's `requests` stayed empty and every dispatch ended at `consume`. This listener is the
// missing hop: the bridge posts `{sessionId, requestId, origin}` to loopback, and the plugin
// forwards it to the handle. The listener never invents an id or an origin.
async function startSourceRegisterListener(section, handle) {
  const config = readSourceRegisterListenerConfig(section);
  if (config.enabled !== true) {
    // Not an error: an unconfigured listener is the default, and a misconfigured one must not stop
    // the plugin from loading (the six tools are still useful without source registration).
    return { listener: null, status: Object.freeze({ state: 'not-started', reason: config.reason }) };
  }
  try {
    const listener = await createQzoneSourceRegisterListener({
      token: config.token,
      port: config.port,
      // The SAME adapter the source-register test uses — see `createHandleRegisterAdapter` for why
      // the normalisation must not be inlined here.
      register: createHandleRegisterAdapter(handle),
    });
    return { listener, status: Object.freeze({ state: 'listening', port: listener.port }) };
  } catch (error) {
    // The bind failed (port taken, permission, ...). Recorded, never fatal — see the header of
    // `source-register-listener.mjs` for why a half-open listener would be worse than none.
    const reason = typeof error?.code === 'string' ? error.code : 'start-failed';
    return { listener: null, status: Object.freeze({ state: 'failed', reason }) };
  }
}

/**
 * Ask the host for a runtime factory. `undefined` means 'nothing injected' — the closed default.
 * @returns {Promise<object|undefined>} the factory's product, or `undefined` when none is injected.
 * @throws {TypeError} when the injection is present but unusable (never silently ignored).
 */
async function buildInjectedRuntime(ctx, enabled) {
  if (!enabled) return undefined;
  let factory;
  try {
    factory = ctx?.[RUNTIME_FACTORY];
  } catch {
    return undefined;
  }
  if (factory === undefined || factory === null) return undefined;
  if (typeof factory !== 'function') {
    throw new TypeError('qzone-safe runtime factory must be a function');
  }
  const runtime = await factory();
  // The three facts the handle and its source lifetime are built on (`index.mjs:40-43,127-217`).
  // `sourceLifetime` stays OPTIONAL here because a runtime without it is a supported shape: the
  // plugin then mints its own per-session ledger (`index.mjs:200-206`).
  if (runtime === null || typeof runtime !== 'object'
      || typeof runtime.dispatch !== 'function'
      || typeof runtime.epoch !== 'string' || runtime.epoch.length === 0
      || (runtime.sourceLifetime !== undefined
        && (runtime.sourceLifetime === null || typeof runtime.sourceLifetime !== 'object'))) {
    throw new TypeError('qzone-safe runtime factory returned a runtime this plugin cannot dispatch over');
  }
  return runtime;
}

/**
 * Retire what `buildInjectedRuntime` produced. Idempotent by contract (`teardown()` returns false
 * on the second call) and never allowed to mask a dispose: this is bookkeeping, not a result.
 */
async function releaseInjectedRuntime(runtime) {
  if (runtime === null || runtime === undefined || typeof runtime.teardown !== 'function') return;
  try { await runtime.teardown(); } catch { /* the handle's disposal is the outcome that matters */ }
}

// ── SELF-ASSEMBLY — the SECOND way a runtime reaches this plugin, and the closed default ─────
//
// A host that injects `qzonePluginRuntimeFactory` wins, unchanged. Only when NOTHING was injected
// does `config.assembly` get read, so an existing deployment cannot be altered by a config key it
// never set.
//
// WHY IT LIVES IN `apply` AND NOT IN `buildInjectedRuntime`: that function's contract — "no
// injected factory ⇒ undefined, no default is invented" — is the thing several tests pin
// (`scripts/test-qzone-wiring-default-states.mjs` T1). Assembly is a DIFFERENT source, chosen
// only after the injected one is known to be absent, so the two rules stay separately readable.
//
// FAILURE POLICY: a configured-but-unusable assembly THROWS. The alternative — quietly returning
// `undefined` — would leave a plugin that the operator explicitly asked to wire sitting in
// `enabled-awaiting-runtime` with every tool answering `dispatch-unavailable`: a half-usable
// surface whose only symptom is "space tools do nothing". A missing `assembly` key is not a
// failure, it is the default (no assembly), and stays silent.
const ASSEMBLY_KEYS = Object.freeze([
  'stateDir', 'initialState', 'origin', 'token', 'botQq', 'approval',
  'sourceEpoch', 'connectionEpoch', 'clock', 'mode', 'writeActions',
  'stateFile', 'sessionLimit', 'trackingLimit',
  // C6 起 host-assembly 接受 writePermitChannel（{origin, token}），配置里要能表达它。
  // 与 writePermit 互斥，由 host-assembly 自己拒绝两者同给（见 that file's TypeError）。
  'writePermitChannel',
  // C13: the bridge registers inbound sources by CALLING the plugin; the plugin therefore needs
  // to know on which fixed port it should listen and with which bearer token.
  'sourceRegister',
]);

/**
 * Read `config.assembly` as a CLOSED option set.
 *
 * @returns the options object, or `null` when assembly was not requested.
 * @throws {TypeError} on a malformed request — an unknown key is refused rather than ignored, for
 *   the same reason the runtime refuses one (`qzone-plugin-host-runtime.mjs:144-153`): a typo would
 *   otherwise silently produce an assembly that is missing the dependency the caller believed in.
 */
function readAssemblyConfig(config) {
  if (config === null || typeof config !== 'object') return null;
  const descriptor = Object.getOwnPropertyDescriptor(config, 'assembly');
  if (descriptor === undefined || descriptor.value === undefined || descriptor.value === null) return null;
  if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('qzone-safe assembly config must be a data property');
  const supplied = descriptor.value;
  if (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw new TypeError('qzone-safe assembly config must be an object');
  }
  const options = {};
  for (const key of Reflect.ownKeys(supplied)) {
    if (typeof key !== 'string' || !ASSEMBLY_KEYS.includes(key)) {
      throw new TypeError('qzone-safe assembly config has an unknown key: ' + String(key));
    }
    const value = Object.getOwnPropertyDescriptor(supplied, key);
    if (!value || !Object.hasOwn(value, 'value')) throw new TypeError('qzone-safe assembly config must not use accessors');
    options[key] = value.value;
  }
  return options;
}

/**
 * Build the runtime from `config.assembly` when the host injected nothing.
 *
 * The returned object carries the three members the handle reads plus `teardown`, so the same
 * disposer that retires an injected runtime also closes this one's database handle and approval
 * sockets (`host-assembly.mjs`).
 *
 * @returns {Promise<object|undefined>} the runtime, or `undefined` when assembly is not requested.
 * @throws {TypeError|Error} when assembly IS requested and cannot be built. Never a silent `undefined`.
 */
async function buildAssembledRuntime(ctx, config) {
  if (config?.enabled !== true) return undefined;
  const options = readAssemblyConfig(config);
  if (options === null) return undefined;
  const built = createQzoneHostAssembly(options);
  // C13: the listener's state lives in this MUTABLE holder, created before the handle and carried
  // on the (frozen) runtime object. The handle is frozen too, so nothing can be attached to it
  // after construction; the holder is how `apply()` reports the listener's fate without adding a
  // fourth parameter to `createQzonePluginHandle` (its signature is pinned by another test).
  const sourceRegisterStatus = { state: 'not-started', reason: 'not-configured' };
  return Object.freeze({
    sourceRegisterStatus,
    epoch: built.runtime.epoch,
    dispatch: built.runtime.dispatch,
    sourceLifetime: built.runtime.sourceLifetime,
    // Whatever this returns is torn down by `releaseInjectedRuntime` (`host-assembly.mjs` closes
    // the store and the approval client there).
    teardown: built.teardown,
    // C13: the listener is started by `apply()` AFTER the handle exists (it needs the handle's
    // `registerBridgeRequest`), so the raw section is carried to it here rather than in
    // `host-assembly.mjs` — that module has no handle and must not learn one.
    sourceRegister: options.sourceRegister,
  });
}

// Cordis accepts an effect disposer (or undefined), not the management handle.
// The default loader stays closed: without an injected factory AND without `config.assembly`
// this is the previous function, byte for byte.
export async function apply(ctx, config) {
  const injected = await buildInjectedRuntime(ctx, config?.enabled === true);
  // An INJECTED factory wins unconditionally; assembly is only the fallback source.
  const runtime = injected === undefined ? await buildAssembledRuntime(ctx, config) : injected;
  let handle;
  try {
    handle = await createQzonePluginHandle(ctx, config, runtime);
  } catch (error) {
    // A handle that never came into existence must not leak the runtime we just built.
    await releaseInjectedRuntime(runtime);
    throw error;
  }

  // ── C13: start the source-registration listener, AFTER the handle exists ──────────────────
  //
  // WHY HERE: the listener's entire job is to call `handle.registerBridgeRequest`, so the handle
  // must already be built. Keeping it out of the handle also keeps a bind failure from aborting
  // handle construction — a plugin that refuses to load because a side channel could not bind is a
  // worse failure than the one it reports.
  //
  // WHY A FAILURE IS NOT FATAL: the six business tools work without source registration; what they
  // lose is the ability to bind an inbound QQ message, i.e. they degrade exactly to the pre-C13
  // behaviour rather than to nothing. The outcome is published on `diagnose().sourceRegister`
  // (`status()`'s field set is pinned elsewhere and this task must not change it).
  const sourceRegisterSection = runtime?.sourceRegister;
  const started = config?.enabled === true && sourceRegisterSection !== undefined
    ? await startSourceRegisterListener(sourceRegisterSection, handle)
    : { listener: null, status: Object.freeze({ state: 'not-started', reason: 'not-configured' }) };
  // Publish on the holder `buildAssembledRuntime` created BEFORE the handle: the handle is frozen,
  // its signature is pinned by another test, and this object is the one channel both sides share.
  const holder = runtime?.sourceRegisterStatus;
  if (holder !== null && typeof holder === 'object') {
    for (const key of Object.keys(holder)) delete holder[key];
    Object.assign(holder, started.status);
    holder.listenerStarted = started.listener !== null;
  }

  return () => {
    // The listener is closed FIRST: after `handle.dispose()` the registration path would refuse
    // anyway, and closing in this order means no request can arrive between the two.
    const closing = started.listener === null ? Promise.resolve() : started.listener.close();
    void handle.dispose()
      .then(() => closing, () => closing)
      .finally(() => releaseInjectedRuntime(runtime));
  };
}

export default Object.freeze({ name, inject, apply });
