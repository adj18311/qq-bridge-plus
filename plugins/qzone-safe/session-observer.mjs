// ONE `session/event` observer per SESSION, shared by every agent on that session.
//
// Why this module exists (R12-4):
//   `session/event` is HOST-scoped. The plugin used to subscribe to it once per AGENT
//   (inside `createQzonePrestepAdapter`), filtered only by `hostSession?.id !== sessionId`.
//   With two agents on one session BOTH adapters observed the SAME `tool/call` and the
//   SAME `turn/end`, which is double bookkeeping against one ledger:
//
//     1. the second `observeToolCall` for a callId hits `spentCalls.has(callId)` and
//        POISONS that callId → that turn's dispatch is `origin-unbound`;
//     2. the second `endTurn` returns false (the first already cleared `activeTurn`) →
//        the adapter's fault branch calls `disconnect()` → the SHARED ledger latches
//        `continuityLost` for good;
//     3. from then on `registerBridgeRequest` throws and every dispatch fails, while
//        `status()` still advertised `dispatchAvailable: true` because the other adapter
//        entry was still live and nothing asked whether the ledger was alive.
//
//   The fix is NOT event deduplication (see the contract note below) — it is giving each
//   session exactly one observer, so one host event is recorded exactly once.
//
// What this module deliberately does NOT do:
//   - It never filters by `(sessionId, turn, step, callId)`. Two different host events
//     that happen to share those fields are NOT the same thing: a duplicated/replayed
//     event must still be caught by the ledger's own replay protection, and swallowing
//     it here would hide a genuine conflict. Deduplicating at this layer would be a
//     security regression, not a performance win. (Pinned by
//     `test-qzone-ordinary-tool-isolation.mjs` "白名单不得削弱防重放".)
//   - It does not decide policy. A fault is reported to the caller through a callback;
//     the caller owns the counters and the lifecycle.

const positive = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * Subscribe to the host session event stream ONCE for one session.
 *
 * @param eventContext - host-scoped Cordis context exposing `on`.
 * @param ledger - the session's origin ledger (shared by every agent on the session).
 * @param sessionId - the session this observer is bound to.
 * @param bindableToolNames - optional Set of tool names worth observing.
 * @param onDisconnected - called ONCE if the ledger must be faulted; the caller marks
 *   every agent on this session unusable.
 * @returns a frozen handle with `dispose()` / `disconnect()` / `disconnected()`.
 */
export function createQzoneSessionObserver({
  eventContext, ledger, sessionId, bindableToolNames, onDisconnected,
} = {}) {
  if (typeof eventContext?.on !== 'function'
    || typeof sessionId !== 'string' || !sessionId
    || typeof ledger?.observeToolCall !== 'function'
    || typeof ledger?.endTurn !== 'function'
    || typeof ledger?.disconnect !== 'function') {
    throw new TypeError('invalid qzone session observer dependencies');
  }
  if (bindableToolNames !== undefined && !(bindableToolNames instanceof Set)) {
    throw new TypeError('bindableToolNames must be a Set when provided');
  }
  if (onDisconnected !== undefined && typeof onDisconnected !== 'function') {
    throw new TypeError('onDisconnected must be a function when provided');
  }

  let active = true;
  let disposing = false;
  let disconnected = false;

  // Teardown is not a fault: `dispose()` runs on a clean lifecycle boundary (the last
  // agent on this session went away), and counting that as a runtime disconnect would
  // make the counter meaningless.
  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    try { ledger.disconnect(); } catch {}
    if (!disposing && typeof onDisconnected === 'function') {
      try { onDisconnected(); } catch {}
    }
  };

  let disposeEvents;
  try {
    disposeEvents = eventContext.on('session/event', (hostSession, event) => {
      if (!active || hostSession?.id !== sessionId) return;
      try {
        if (event?.type === 'tool/call') {
          // An ABSENT name is observed, not filtered: the host always writes `name`, so
          // a missing one means this is not the event shape the filter was reasoned
          // about. Filtering it would turn a host quirk into a silent dispatch failure.
          const toolName = event?.data?.name;
          if (bindableToolNames !== undefined && typeof toolName === 'string' && toolName
            && !bindableToolNames.has(toolName)) return;
          ledger.observeToolCall({ sessionId, event });
        } else if (event?.type === 'turn/end') {
          if (!positive(event?.data?.turn) || ledger.endTurn({ sessionId, turn: event.data.turn }) !== true) disconnect();
        }
      } catch { disconnect(); }
    });
    if (typeof disposeEvents !== 'function') throw new TypeError('qzone session observer subscription must be disposable');
  } catch {
    active = false;
    try { if (typeof disposeEvents === 'function') disposeEvents(); } catch {}
    disconnect();
    throw new Error('qzone session observer subscription failed');
  }

  return Object.freeze({
    disconnect,
    disconnected: () => disconnected,
    // "Actually alive" = neither faulted NOR torn down.
    //
    // `disconnected` alone is NOT enough: `dispose()` only clears `active`, so a
    // disposed observer used to keep reporting `alive(): true` while its subscription
    // was gone. Any caller that reads `alive()` to decide whether a session can
    // dispatch would then promise a session whose observer no longer records events.
    //
    // `disconnected()` deliberately keeps its old meaning — it is the FAULT latch, not
    // the lifecycle flag. A clean teardown is not a fault, and conflating the two is
    // what made the old `adaptersDisconnected` counter meaningless.
    alive: () => active && !disconnected,
    disposed: () => !active,
    dispose() {
      if (!active) return;
      active = false;
      disposing = true;
      try { disposeEvents(); } catch {}
      disposing = false;
    },
  });
}
