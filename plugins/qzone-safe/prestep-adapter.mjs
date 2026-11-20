// Adapt DSH's agent-scoped pre-step middleware to an injected origin ledger.
//
// Scope: ONLY `agent/pre-step`, which really is agent-scoped — one adapter per agent is
// correct for that stream.
//
// `session/event` is HOST-scoped and must be observed once per SESSION, not once per
// agent: two agents on one session used to record the same `tool/call` twice (poisoning
// the callId via `spentCalls`) and the same `turn/end` twice (the second `endTurn`
// returns false, the fault branch disconnects the SHARED ledger), killing the whole
// session behind `dispatchAvailable: true`. That observation lives in
// `session-observer.mjs`, and the plugin creates exactly ONE per session.
//
// R12-2 / Codex ruling 2: this module used to accept an optional `eventContext` plus
// `bindableToolNames` and build a private session observer (with its name filter) from
// them. That kept the agent-granularity shape reachable and left production correctness
// resting on "the plugin happens not to pass it" — a convention, not a constraint. Both
// parameters are GONE, and passing either one now THROWS instead of being ignored:
// a caller that believes it filtered ordinary tool traffic but silently did not widens
// what reaches the ledger, and a caller that believes it subscribed to `session/event`
// but silently did not gets a session that looks dispatchable and can never bind.
// Callers construct `createQzoneSessionObserver` themselves.

const positive = (value) => Number.isSafeInteger(value) && value > 0;

// Options this module no longer implements. Kept as data so the error names every one
// the caller actually passed, and so the removal is enforced at runtime rather than
// merely documented in a comment.
const MOVED_OPTIONS = ['eventContext', 'bindableToolNames'];

/**
 * @param agentContext - the live agent's ctx (pre-step is agent-scoped here).
 * @param ledger - the session's origin ledger.
 * @param sessionId - the session this agent belongs to.
 * @param onStepRefused - called when `observeStep` refuses (a lost-source symptom).
 * @param onDisconnected - called ONCE if this agent's pre-step stream must be faulted.
 */
export function createQzonePrestepAdapter(options = {}) {
  const { agentContext, ledger, sessionId, onStepRefused, onDisconnected } = options ?? {};
  // `undefined` counts as absent: a caller spreading `{ ...(cond ? { x } : {}) }` must
  // keep working. Any real value is a caller that expects behaviour this module no
  // longer has, which is exactly the silent-failure mode being removed.
  const moved = MOVED_OPTIONS.filter((key) => options?.[key] !== undefined);
  if (moved.length > 0) {
    throw new TypeError(`createQzonePrestepAdapter no longer accepts ${moved.join('/')}: `
      + 'session events are observed once per session by createQzoneSessionObserver (session-observer.mjs)');
  }
  if (typeof agentContext?.on !== 'function'
    || typeof sessionId !== 'string' || !sessionId
    || typeof ledger?.observeStep !== 'function'
    || typeof ledger?.disconnect !== 'function') {
    throw new TypeError('invalid qzone prestep adapter dependencies');
  }
  if (onStepRefused !== undefined && typeof onStepRefused !== 'function') {
    throw new TypeError('onStepRefused must be a function when provided');
  }
  if (onDisconnected !== undefined && typeof onDisconnected !== 'function') {
    throw new TypeError('onDisconnected must be a function when provided');
  }

  let active = true;
  let disconnected = false;
  let disposing = false;
  // A faulted pre-step stream means this agent can no longer bind anything: `observeStep`
  // either threw or the payload was malformed, and `disconnect()` latches
  // `continuityLost`. Report it so the caller can stop advertising the session.
  //
  // Teardown is NOT such a failure: `dispose()` runs on a clean boundary and must not
  // make a clean shutdown look like a runtime fault.
  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    try { ledger.disconnect(); } catch {}
    if (!disposing && typeof onDisconnected === 'function') {
      try { onDisconnected(); } catch {}
    }
  };

  let disposePreStep;
  try {
    disposePreStep = agentContext.on('agent/pre-step', (payload, next) => {
      if (!active) return typeof next === 'function' ? next() : undefined;
      try {
        if (!payload || !positive(payload.turn) || !positive(payload.step) || !Array.isArray(payload.messages)) {
          disconnect();
        } else {
          // `observeStep` returns false for every refusal it makes — unknown session,
          // stale/duplicate/out-of-order turn, a step that repeats or skips, a turn that
          // cited two different request ids. Discarding that bool left the adapter
          // subscribed and mute: the ledger refused forever while nothing anywhere
          // recorded it. Report it, do NOT disconnect: a single stale or duplicated
          // delivery must not kill the connection.
          const bound = ledger.observeStep({ sessionId, turn: payload.turn, step: payload.step, messages: payload.messages });
          if (bound !== true && typeof onStepRefused === 'function') {
            try { onStepRefused({ turn: payload.turn, step: payload.step }); } catch {}
          }
        }
      } catch {
        disconnect();
      }
      return typeof next === 'function' ? next() : undefined;
    });

    if (typeof disposePreStep !== 'function') {
      throw new TypeError('qzone pre-step subscription must be disposable');
    }
  } catch {
    active = false;
    try { if (typeof disposePreStep === 'function') disposePreStep(); } catch {}
    disconnect();
    throw new Error('qzone prestep event subscription failed');
  }

  return Object.freeze({
    disconnected: () => disconnected,
    disconnect,
    dispose() {
      if (!active) return;
      active = false;
      disposing = true;
      try { disposePreStep(); } catch {}
      disposing = false;
    },
  });
}