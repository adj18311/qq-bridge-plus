// Offline prototype only. Registration represents a trusted bridge boundary;
// this module does not authenticate callers and is not a production capability.
// A one-shot call binding is not a one-shot historical-access grant: a single
// step can issue multiple tool calls. A separate scoped grant must enforce that.
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const keyOf = (turn, step) => `${turn}:${step}`;
// Same charset the rest of the subsystem already enforces on a session id
// (`qzone-source-lifetime-offline.mjs:7`, `qzone-session-mapper.mjs:1`,
// `qzone-runtime-wiring.mjs:33`). This constructor used to accept any non-empty
// string, so the plugin's non-lifetime fallback
// (`plugins/qzone-safe/index.mjs:69`) could build a ledger bound to a session id
// that no other gate in the tree would ever accept.
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
// Closed turns are remembered only long enough to reject a late replays; a turn
// can never be reopened because `observeStep` requires exactly `maxTurn + 1`.
const ENDED_TURN_WINDOW = 64;

// Results issued by consume() are recorded here so downstream trust code can
// recognise a genuine ledger consumption without trusting a caller's object shape.
const issuedConsumptions = new WeakMap();
const issuedOwners = new WeakMap();
export function isOriginLedgerConsumption(value) {
  if (value === null || typeof value !== 'object') return false;
  const valid = issuedConsumptions.get(value);
  return typeof valid === 'function' && valid();
}

export function createQzoneOriginLedger({ sessionId, epoch, trackingLimit = 4096 } = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || typeof epoch !== 'string' || !epoch) {
    throw new TypeError('sessionId 与 epoch 必填');
  }
  if (!Number.isSafeInteger(trackingLimit) || trackingLimit < 1 || trackingLimit > 4096) throw new TypeError('trackingLimit 非法');

  const requests = new Map();
  const ledgerIdentity = Object.freeze({});
  const usedRequests = new Map();
  const poisonedRequests = new Set();
  const steps = new Map();
  const calls = new Map();
  // Permanent replay guard for tool calls. `calls` entries are reaped at
  // `endTurn` (otherwise a consumed callId leaves a tombstone behind and a small
  // `trackingLimit` eventually refuses every new tool/call), so single-use has
  // to be remembered somewhere that outlives the reap. This set is deliberately
  // NOT capacity-limited: capping it would reintroduce the lockout it exists to
  // prevent, and its growth is one short string per tool call actually observed.
  const spentCalls = new Set();
  const callTurns = new Map();
  const poisonedCalls = new Set();
  const ended = new Set();
  const taintedTurns = new Set();
  const turnRequests = new Map();
  // turn -> the STEP whose `messages` cited the source (t26). One entry per turn, because a
  // turn cites exactly one request (a second distinct id taints the turn). Later steps of the
  // same turn carry tool results, not a new source, so a tool call issued on step 2 must still
  // resolve back to the step that actually introduced provenance.
  const turnSourceStep = new Map();
  let maxTurn = 0;
  let activeTurn = null;
  let continuityLost = false;
  // Observable counterpart of the capacity refusal below. The plugin layer already
  // counts the position it evicts (`positionsEvictedLive`), but one overflow costs a
  // SECOND pending call here, silently: `calls` refuses the newest callId and no
  // counter moves, so an operator reading status sees one loss where two happened.
  // Counting it is additive — the refusal itself stays terminal and fail-closed.
  let callsRefusedCapacity = 0;

  // Capacity is a LOCAL refusal, never a global poison. Setting `continuityLost`
  // here used to make one exhausted collection kill the whole ledger forever:
  // `validSession` returned false, `reconnect()` could not revive it, and since
  // nothing was ever reaped the limit was reachable by ordinary use (a model
  // retrying a known-but-unwired tool reached it in a few thousand calls). Each
  // map now refuses only the entry that would overflow, and `endTurn` reaps the
  // per-turn maps so a small limit still supports an unbounded number of turns.
  function canAdd(collection, key) {
    return collection.has(key) || collection.size < trackingLimit;
  }

  function validSession(input) {
    return input?.sessionId === sessionId && !continuityLost;
  }

  return {
    ownsConsumption(value) {
      return isOriginLedgerConsumption(value) && issuedOwners.get(value) === ledgerIdentity;
    },
    registerBridgeRequest(input) {
      const id = input?.requestId;
      if (typeof id !== 'string' || !id || !['qq-inbound', 'schedule'].includes(input?.origin)) {
        throw new TypeError('桥接 request 登记非法');
      }
      // Length gate. Every other id in this subsystem is capped at 128
      // (`CTX_ID` in qzone-runtime-wiring.mjs, `SESSION_ID` in
      // qzone-session-mapper.mjs, the business ids in qzone-mcp-contract.mjs), but
      // the bridge requestId reaches this boundary unchecked. `requests` and
      // `usedRequests` retain the id string for the life of the ledger and neither
      // has an upper bound, so an over-long value would be pinned in memory with no
      // delete path. Refusing it here is the fail-closed direction and keeps the
      // retention per request bounded by the same 128 characters as everything
      // else.
      if (id.length > 128) throw new TypeError('桥接 request 登记非法');
      if (continuityLost) throw new Error('来源账本不可用或已满');
      if (requests.has(id)) {
        requests.set(id, null);
        poisonedRequests.add(id);
        for (const [callId, binding] of calls) {
          if (binding?.requestId === id) calls.set(callId, null);
        }
        throw new TypeError('requestId 重复');
      }
      if (!canAdd(requests, id)) {
        // A registered-but-never-observed request is dead weight: `endTurn` only
        // reaps the request of the turn it closes, so a bridge request whose turn
        // never arrives (model error, aborted turn, dropped reply) would occupy a
        // `requests` slot for the life of the ledger. Enough of those reach
        // `trackingLimit` and every later registration throws, locking the whole
        // session out without any attacker.
        //
        // Reaping the OLDEST never-observed request is safe in the authentication
        // sense: a bare registration authenticates nothing, no step ever cited the
        // id, so no binding and no consumption can depend on it. The id is poisoned
        // on eviction, so if that turn does arrive late its step is tainted and its
        // tool calls stay refused — the failure moves from "every future request is
        // refused" to "this one stale request is refused", which is the same
        // fail-closed direction. Request ids that WERE observed (`usedRequests`) are
        // never evicted here; they belong to a live or not-yet-reaped turn.
        let reaped = null;
        for (const candidate of requests.keys()) {
          if (!usedRequests.has(candidate)) { reaped = candidate; break; }
        }
        if (reaped === null) throw new Error('来源账本不可用或已满');
        requests.delete(reaped);
        poisonedRequests.add(reaped);
        for (const [callId, binding] of calls) {
          if (binding?.requestId === reaped) calls.set(callId, null);
        }
      }
      requests.set(id, input.origin);
    },

    observeStep(input) {
      if (!validSession(input) || !positive(input.turn) || !positive(input.step) || !Array.isArray(input.messages)) return false;
      const turn = input.turn;
      if (ended.has(turn)) return false;
      if (activeTurn === null) {
        // A turn at or below `maxTurn` was already observed and closed: `ended`
        // only remembers the last `ENDED_TURN_WINDOW` turns, so an older number
        // lands here instead of the `ended` check above. Refusing is enough — this
        // branch records nothing, so a stale or replayed pre-step gains nothing by
        // being sent. Setting `continuityLost` here used to disable the ledger
        // PERMANENTLY: one duplicate pre-step delivered more than 64 turns late
        // (a retried action, a resumed agent, a slow queue) killed every later
        // turn for the rest of the connection, with no way to recover short of
        // rotating the ledger. Only a genuine forward gap (below) is treated as
        // lost evidence.
        if (turn <= maxTurn) return false;
        if (maxTurn !== 0 && turn !== maxTurn + 1) { continuityLost = true; return false; }
        activeTurn = turn;
        maxTurn = turn;
      } else if (turn !== activeTurn) {
        // A pre-step for a turn OLDER than the one in flight is a late or
        // duplicated delivery, not evidence that history was lost. Refusing it is
        // enough: this branch records nothing, so the stale step gains nothing.
        //
        // Latching `continuityLost` here was permanently destructive. The adapter
        // discards the return value of `observeStep` (it only disconnects on a
        // throw), so a single out-of-order or late pre-step left the whole ledger
        // dead for the rest of the connection — every later turn refused, no audit
        // row, `status()` still reporting ready. Measured: one late pre-step for an
        // older turn, then a genuine turn 1 → not bound, no binding, no platform
        // call, and nothing anywhere recorded why.
        //
        // A jump FORWARD past the active turn is still treated as lost evidence:
        // that is the one case where the ledger really cannot tell what it missed.
        if (turn < activeTurn) return false;
        continuityLost = true;
        return false;
      }

      const key = keyOf(turn, input.step);
      if (!canAdd(steps, key)) return false;
      if (steps.has(key)) {
        steps.set(key, null);
        for (const [callId, binding] of calls) {
          if (binding?.turn === turn && binding.step === input.step) calls.set(callId, null);
        }
        return false;
      }
      const priorSteps = [...steps.keys()]
        .filter((entry) => entry.startsWith(`${turn}:`))
        .map((entry) => Number(entry.slice(entry.indexOf(':') + 1)));
      const expected = priorSteps.length ? Math.max(...priorSteps) + 1 : 1;
      if (input.step !== expected) {
        steps.set(key, null);
        return false;
      }

      let requestId = null;
      // ── WHICH MESSAGE CARRIES THE SOURCE (t25) ────────────────────────────────────────────────
      //
      // This used to require `input.messages.length === 1`. That held only in a synthetic
      // single-message turn: a REAL DSH turn prepends host context (runtime-context,
      // time-context, skill-catalog) next to the user message, so the length was never 1 and
      // the ledger could NEVER obtain a requestId. Measured on live QQ sessions: every
      // qzone_* call had `turnRpc=(none)`, the consume refused, and the tool answered
      // `origin-unbound` no matter how the caller invoked it.
      //
      // The rule is now "exactly one message CARRIES a source", not "exactly one message
      // exists". That is the same trust statement, stated correctly: host-injected context
      // messages have no `source.rpcId`, so they cannot supply a source, cannot crowd one
      // out (they are not counted), and cannot be forged into one here. Two or more
      // rpcId-carrying messages is still ambiguous and still taints the turn.
      const sourced = [];
      for (const candidate of input.messages) {
        if (candidate?.role !== 'user') continue;
        const rpc = candidate.source?.rpcId;
        if (typeof rpc === 'string' && rpc) sourced.push({ rpc, message: candidate });
      }
      // More than one distinct rpcId in one step is mixed provenance: refuse to pick.
      // Repeating the SAME rpcId is not mixed (a retried/duplicated message), and the
      // usedRequests check below already poisons a genuinely replayed id.
      const distinctRpc = new Set(sourced.map((entry) => entry.rpc));
      if (distinctRpc.size === 1) {
        const { rpc } = sourced[0];
        const origin = requests.get(rpc);
        if (origin && !poisonedRequests.has(rpc)) {
          requestId = rpc;
          if (usedRequests.has(requestId)) {
            poisonedRequests.add(requestId);
            for (const [callId, binding] of calls) {
              if (binding?.requestId === requestId) calls.set(callId, null);
            }
            requestId = null;
          } else {
            usedRequests.set(requestId, key);
          }
        }
      }
      // ── WHEN A STEP TAINTS THE TURN (t27) ──────────────────────────────────────────────────
      //
      // The old rule was `messages.length > 0 && requestId === null`, i.e. "this step had input but
      // produced no source". On a real DSH turn every step after the first has input — TOOL
      // RESULTS and host context — so step 2 onward tainted the turn that step 1 had just
      // legitimately sourced. Measured on a live QQ session (turn 148): step 1 cited
      // rpcId 7c2c0d09, step 2 carried tool results, the turn became tainted, and every later
      // qzone call answered `origin-unbound`.
      //
      // The honest question is not "did this step have input" but "did this step introduce a
      // USER REQUEST that we could not resolve". A tool result is not a new source and cannot
      // taint anything. So the turn is tainted only when:
      //   · a message CLAIMS to be a user request (carries `source.rpcId`) and we still could not
      //     resolve it (unregistered, poisoned, or already used); or
      //   · the step cites more than one DISTINCT rpcId (mixed provenance).
      // A step whose messages are only tool results / host context changes nothing.
      const claimsSource = sourced.length > 0;
      if ((claimsSource || distinctRpc.size > 1) && requestId === null) taintedTurns.add(turn);
      if (requestId !== null) {
        // `turnRequests` must remember EVERY requestId cited by this turn, not just
        // the first one. `endTurn` reaps `requests` through this map, and the
        // capacity reap at `registerBridgeRequest` skips any id in `usedRequests` —
        // so an id that a step cited but that this map forgot could never be
        // reaped by either path and stayed in `requests` for the life of the
        // ledger. Once `trackingLimit - 1` turns had each cited two ids, `requests`
        // was permanently full of unfreeable entries and every later turn lost its
        // FIRST step: adding that turn's second id reaped the first one (it was
        // the oldest id without `usedRequests`) and poisoned it. Tainting is
        // unchanged: a turn that cites two DIFFERENT ids is still tainted, we just
        // also record the extra id so it can be reaped with its own turn.
        const cited = turnRequests.get(turn);
        if (cited === undefined) {
          turnRequests.set(turn, new Set([requestId]));
          // The step that INTRODUCED this turn's source. Recorded only on the first citation
          // so a later step cannot overwrite it with itself.
          turnSourceStep.set(turn, input.step);
        } else {
          if (!cited.has(requestId)) taintedTurns.add(turn);
          cited.add(requestId);
        }
      }
      steps.set(key, requestId);
      return requestId !== null;
    },

    observeToolCall(input) {
      if (!validSession(input) || input.event?.type !== 'tool/call') return false;
      const data = input.event.data;
      const callId = data?.callId;
      if (typeof callId !== 'string' || !callId) return false;
      // Same length gate as `registerBridgeRequest`: `spentCalls` retains every
      // callId for the life of the ledger with no delete path, and a dispatch-side
      // `CTX_ID` check never sees the ids reported through `session/event`.
      if (callId.length > 128) return false;
      // A callId seen once is spent forever. This check must precede every other
      // branch (including capacity) and must not be defeated by the `calls` reap.
      // Re-reporting it also poisons whatever is still outstanding for it: the
      // original behaviour made a duplicate report self-destructive, and a
      // pending binding must not survive because its tombstone was reaped.
      if (spentCalls.has(callId)) {
        if (calls.has(callId)) calls.set(callId, null);
        poisonedCalls.add(callId);
        return false;
      }
      // Spend the id BEFORE the capacity decision. A callId refused because `calls`
      // was full used to stay unspent, so the same report could be refused once and
      // then accepted in a later turn: the refusal was advisory instead of final.
      // Spending first keeps every refusal terminal, which is the fail-closed
      // direction and matches the other refusal branches below.
      spentCalls.add(callId);
      if (!canAdd(calls, callId)) {
        callsRefusedCapacity += 1;
        return false;
      }
      if (calls.has(callId)) {
        // Unreachable while every write into `calls` is paired with a
        // `spentCalls.add` above the branch (the spent check at the top of this
        // method returns first), which is why it carries no test of its own — a
        // test for it would have to fabricate an impossible state. Kept as a
        // defence in depth so a future write into `calls` that forgets to spend
        // the id still poisons instead of silently allowing a second binding.
        calls.set(callId, null);
        poisonedCalls.add(callId);
        return false;
      }
      const turn = data?.turn;
      const step = data?.step;
      const validPosition = positive(turn) && positive(step) && !ended.has(turn) && turn === activeTurn;
      if (!validPosition) {
        // An out-of-position tool/call can never yield a binding, so it must not
        // hold a `calls` slot. Recording it there used to be permanent: the entry
        // was tagged with turn 0 (an invalid turn), which `endTurn` never reaps,
        // so `trackingLimit` stray events filled the capacity and every later
        // legitimate call was refused for the rest of the session. Replay is still
        // covered: `spentCalls` refuses this callId forever and the absent
        // `calls` entry makes `peekCall`/`consume` return null.
        return false;
      }
      // ── WHICH STEP OWNS THE SOURCE (t26) ──────────────────────────────────────────────────────
      //
      // A turn cites its source ONCE, on its first step: that is the only step whose `messages`
      // contain the inbound user message. Every later step of the same turn carries tool results
      // and host context, so `observeStep` records `steps[turn:step] = null` for them — correctly,
      // because THAT STEP introduced no new source.
      //
      // Looking the source up by the tool call's own step therefore made every call issued after
      // the first step unbound. Measured on a live QQ session (turn 148): step 1 carried
      // `rpcId 7c2c0d09`, the model called `qzone_read_posts` on step 2, and the answer was
      // `origin-unbound` — the turn HAD a source, the lookup just asked the wrong step.
      //
      // The rule is now turn-scoped, which is what a turn-level provenance claim actually means:
      // fall back to the STEP THAT CITED THE SOURCE within this same turn. It is not a widening:
      //   · `turnRequests` already refuses a turn that cited more than one distinct requestId
      //     (`taintedTurns`), and a tainted turn is rejected below like everywhere else;
      //   · the requestId must still be registered (`requests`), unpoisoned and unused;
      //   · `consume` re-validates turn/step/request against its own record, so a binding minted
      //     here still names the step the tool call actually belongs to.
      const ownStepRequestId = steps.get(keyOf(turn, step));
      let requestId = ownStepRequestId;
      if (requestId === null || requestId === undefined) {
        if (taintedTurns.has(turn)) return false;
        const cited = turnRequests.get(turn);
        const sourceStep = turnSourceStep.get(turn);
        // Exactly one cited id ⇒ that id is this turn's single source. Anything else (none, or
        // several) cannot be resolved here and fails closed.
        //
        // AND the call must belong to a step AFTER the one that cited it. A call on the citing
        // step itself already resolved above; a call on an EARLIER step is a replay/out-of-order
        // delivery, not an inheritor, and must stay unbound (t26 regression: a tool call reported
        // for turn 1 after the turn had closed used to fall back to the turn's old source).
        requestId = cited !== undefined && cited.size === 1
          && Number.isSafeInteger(sourceStep) && step > sourceStep
          ? [...cited][0] : null;
      }
      if (typeof requestId !== 'string' || !requestId) {
        calls.set(callId, null);
        callTurns.set(callId, turn);
        return false;
      }
      calls.set(callId, { turn, step, requestId });
      callTurns.set(callId, turn);
      return true;
    },

    // Read-only lookup of the turn/step that observeToolCall recorded for a
    // pending callId. This is ledger-owned evidence, not caller-supplied; consume()
    // still re-validates every field before issuing a binding.
    peekCall(callId) {
      if (continuityLost || typeof callId !== 'string' || !callId) return null;
      const binding = calls.get(callId);
      return binding ? { turn: binding.turn, step: binding.step } : null;
    },

    consume(input) {
      if (!validSession(input) || typeof input.callId !== 'string' || !input.callId
        || !positive(input.turn) || !positive(input.step)) return null;
      const binding = calls.get(input.callId);
      if (!binding || binding.turn !== input.turn || binding.step !== input.step || taintedTurns.has(binding.turn)
        || ended.has(binding.turn) || poisonedRequests.has(binding.requestId)
        || !requests.get(binding.requestId)) return null;
      calls.set(input.callId, null);
      const result = Object.freeze({
        requestId: binding.requestId,
        origin: requests.get(binding.requestId),
        sessionId,
        epoch,
        turn: binding.turn,
        step: binding.step,
        callId: input.callId,
      });
      // ── THE VALIDITY RE-CHECK MUST USE THE SAME SOURCE RULE (t28) ─────────────────────────────
      //
      // The last clause used to be `steps.get(turn:binding.step) === requestId`. For a call on a
      // LATER step than the one that cited the source, `steps[turn:step]` is null by design, so
      // the consumption was minted successfully and then declared invalid the instant anything
      // asked — `origin-unverified` on every read after step 1, and on every write.
      //
      // It must agree with `observeToolCall`, which is now turn-scoped: either this very step
      // cited the source, or the step that did is earlier in the same turn.
      const citedByOwnStep = steps.get(keyOf(binding.turn, binding.step)) === binding.requestId;
      const sourceStep = turnSourceStep.get(binding.turn);
      const citedByTurn = Number.isSafeInteger(sourceStep) && binding.step > sourceStep &&
        turnRequests.get(binding.turn)?.size === 1 &&
        [...(turnRequests.get(binding.turn) ?? [])][0] === binding.requestId;
      issuedConsumptions.set(result, () => !continuityLost && !ended.has(binding.turn) &&
        !taintedTurns.has(binding.turn) && !poisonedRequests.has(binding.requestId) &&
        !poisonedCalls.has(result.callId) &&
        requests.get(binding.requestId) === result.origin &&
        (citedByOwnStep || citedByTurn));
      issuedOwners.set(result, ledgerIdentity);
      return result;
    },

    endTurn(input) {
      if (input?.sessionId !== sessionId || !positive(input.turn) || input.turn !== activeTurn) return false;
      ended.add(input.turn);
      // `ended` only needs the recent window: `observeStep` refuses any turn that
      // is not exactly `maxTurn + 1`, so a closed turn can never be reopened, and
      // after the reaping below neither `consume` nor `peekCall` can resolve one.
      // Bounding it keeps the bookkeeping from scaling with session lifetime.
      if (ended.size > ENDED_TURN_WINDOW) {
        const oldest = Math.min(...ended);
        ended.delete(oldest);
        taintedTurns.delete(oldest);
      }
      activeTurn = null;
      // Reap this turn's per-turn evidence so `trackingLimit` bounds concurrent
      // state instead of lifetime traffic. Reaping is ABA-safe because both maps
      // are only ever read for the active turn: `observeStep` rejects an ended or
      // non-`maxTurn + 1` turn before reading `steps`, and `consume`/`peekCall`
      // reject a closed turn before reading `calls`. Replay protection is NOT
      // weakened: `usedRequests` keeps the requestId permanently and
      // `poisonedRequests` / `poisonedCalls` are never pruned, so re-registering
      // or re-observing a spent id in a later turn is still poisoned.
      for (const [callId, turn] of callTurns) {
        if (turn === input.turn) {
          calls.delete(callId);
          callTurns.delete(callId);
        }
      }
      const stepPrefix = `${input.turn}:`;
      for (const key of steps.keys()) {
        if (key.startsWith(stepPrefix)) steps.delete(key);
      }
      // t35: the citation STEP must be reaped with the rest of the turn's evidence. Without
      // this line it grew one entry per closed turn for the whole session lifetime — the only map
      // in this ledger that was never pruned.
      turnSourceStep.delete(input.turn);
      const turnRequestsForTurn = turnRequests.get(input.turn);
      if (turnRequestsForTurn !== undefined) {
        turnRequests.delete(input.turn);
        // Every id this turn cited is reaped, not just the first one. Leaving the
        // extra ids behind pinned them in `requests` forever: the capacity reap
        // skips `usedRequests` entries and this loop used to delete only one id.
        // `usedRequests` still remembers each of them, so dropping the per-turn
        // origin records cannot reopen a replay window.
        for (const requestId of turnRequestsForTurn) requests.delete(requestId);
      }
      return true;
    },

    // A disconnect breaks ordering evidence: nothing observed before the break
    // may be trusted afterwards, so the ledger stays failed closed until the
    // owner replaces it. `reconnect()` deliberately does NOT revive a ledger:
    // its only production caller is the source-lifetime retire path, which
    // replaces the ledger together with the epoch, and reviving one here would
    // let a retired generation accept traffic again with a stale epoch. Capacity
    // exhaustion no longer reaches this flag at all (see `canAdd`), and per-turn
    // state is reaped at `endTurn`, so ordinary use never accumulates into it.
    disconnect() { continuityLost = true; },

    reconnect() { continuityLost = true; },

    // Read-only telemetry. `callsRefusedCapacity` counts tool/call observations this
    // ledger dropped because `calls` was full — the half of an overflow that used to
    // leave no trace at all. It is deliberately NOT included in any security
    // decision: nothing reads it, so a caller cannot influence or bypass a gate with it.
    stats() {
      return Object.freeze({ callsRefusedCapacity, spentCalls: spentCalls.size, usedRequests: usedRequests.size });
    },

    // Read-only liveness probe. `continuityLost` is a one-way latch (see
    // `disconnect()` above), so a caller that receives a ledger it did not create
    // cannot otherwise tell whether that ledger can still consume. Without this the
    // plugin installed a fresh pre-step adapter on a ledger closed by an earlier
    // `agent/disposed`, then reported `dispatchAvailable: true` while every call
    // failed `origin-unbound` — the exact false promise this probe exists to stop.
    // Deliberately NOT part of any security decision: nothing reads it to grant
    // access, and it reports state the caller could already infer by trying.
    alive() { return continuityLost !== true; },
  };
}
