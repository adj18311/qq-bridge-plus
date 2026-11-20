// In-process approval queue for the authenticated QZone management console.
// The host must expose listPending/decide only behind console authentication and CSRF checks.
// No listener, production wiring, or implicit approval is created here.
//
// WITHDRAW — closing a ticket nobody is waiting for any more
// ----------------------------------------------------------
// 'approveOperation' hands out a promise that the caller waits on. When the caller STOPS waiting
// (the cross-process channel timed out, the socket died), the ticket used to sit in 'pending' until
// its own 'expiresAt', i.e. the operator's console still offered an approval button for a request
// that had already been abandoned. Pressing it answered 'true' and wrote an 'approval/approved' row.
//
// 'withdraw(authorizationId)' closes exactly that ticket without a decision: the waiter gets
// 'false', NO 'recordDecision' call happens, and therefore NO audit row is produced. It does not
// invent a "rejected" verdict — a withdrawn ticket has no decision at all, which is the honest
// description of an abandoned request.
//
// THE COMPETITION BETWEEN withdraw() AND decide(), AND WHY ONLY THE ORDER MATTERS
// ------------------------------------------------------------------------------
// Both go through the same 'finish()', which is a single synchronous 'pending.delete' — so exactly
// one of them closes a given ticket, and the loser sees no entry and returns 'false'. That is the
// whole rule:
//   · withdraw first  -> the ticket is gone, the late 'decide(approved:true)' returns 'false' and
//                        writes nothing. This is what the channel relies on after a timeout.
//   · decide first    -> the decision (and its audit row, written synchronously inside 'decide' before
//                        'finish') is already durable; a later 'withdraw' finds no entry, returns
//                        'false' and MUST NOT touch the row. A real approval stays a real approval.
//
// WHAT A RECORDED 'approved' ROW DOES **NOT** MEAN (important, and not a defect to be "fixed")
// ---------------------------------------------------------------------------------------------
// An 'approval/approved' row is the operator's DECISION. When a human really approved, that row is
// true and must survive. Two things are separate questions, and neither is answered by that row:
// whether the operation was ever dispatched, and whether the platform accepted it — those are the
// 'intent' / 'result' rows. The gap this module now narrows is narrower than "ghost approvals": a
// request that had already been abandoned can no longer be approved at all. Withdraw exists for
// exactly that, and it is deliberately silent rather than writing a fake 'rejected'.
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_WAIT_MS = 30000;

function freezeTree(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export function createQzoneOperationApprovalBroker({ clock = Date.now, capacity = 64, recordDecision } = {}) {
  if (typeof clock !== 'function' || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024 ||
      (recordDecision !== undefined && typeof recordDecision !== 'function')) {
    throw new TypeError('invalid approval broker options');
  }
  const pending = new Map();

  function finish(id, approved) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(approved === true);
    return true;
  }

  function purgeExpired() {
    let now;
    try { now = clock(); } catch { now = NaN; }
    for (const [id, entry] of pending) {
      if (!Number.isSafeInteger(now) || now >= entry.operation.expiresAt) finish(id, false);
    }
  }

  function approveOperation(operation) {
    try {
      purgeExpired();
      const now = clock();
      if (!operation || typeof operation.authorizationId !== 'string' || !ID.test(operation.authorizationId) ||
          typeof operation.inputDigest !== 'string' || !DIGEST.test(operation.inputDigest) ||
          !Number.isSafeInteger(now) || !Number.isSafeInteger(operation.expiresAt) ||
          operation.expiresAt <= now || operation.expiresAt - now > MAX_WAIT_MS ||
          pending.has(operation.authorizationId) || pending.size >= capacity) return Promise.resolve(false);
      // The authorizer supplies a frozen operation. Keep a private copy for the console so a
      // caller cannot change what the operator sees while a decision is pending.
      const snapshot = freezeTree(JSON.parse(JSON.stringify(operation)));
      return new Promise((resolve) => {
        const id = snapshot.authorizationId;
        const timer = setTimeout(() => finish(id, false), snapshot.expiresAt - now);
        pending.set(id, { operation: snapshot, resolve, timer });
      });
    } catch { return Promise.resolve(false); }
  }

  function listPending() {
    purgeExpired();
    return Object.freeze([...pending.values()].map((entry) => entry.operation));
  }

  function decide({ authorizationId, inputDigest, approved } = {}, { operator } = {}) {
    purgeExpired();
    if (typeof authorizationId !== 'string' || !ID.test(authorizationId) ||
        typeof inputDigest !== 'string' || !DIGEST.test(inputDigest) || typeof approved !== 'boolean') return false;
    const entry = pending.get(authorizationId);
    if (!entry || entry.operation.inputDigest !== inputDigest) return false;
    if (recordDecision) {
      // The gateway supplies operator from its verified server-side session, never the body.
      // Audit is synchronous: do not approve when the decision cannot be durably recorded.
      if (typeof operator !== 'string' || !ID.test(operator)) { finish(authorizationId, false); return false; }
      try {
        const recorded = recordDecision(Object.freeze({ operation: entry.operation, operator, approved }));
        if (recorded !== true) {
          if (recorded && typeof recorded.then === 'function') Promise.resolve(recorded).catch(() => {});
          finish(authorizationId, false);
          return false;
        }
      } catch { finish(authorizationId, false); return false; }
    }
    return finish(authorizationId, approved);
  }

  /**
   * Close ONE still-pending ticket WITHOUT recording a decision.
   *
   * Use it when the caller that asked has demonstrably stopped waiting (channel timeout, dropped
   * connection). It answers strict 'true' only when THIS call closed the ticket; 'false' means there
   * was nothing left to withdraw — a decision already landed, the ticket expired, or the id is not
   * (and never was) pending. Repeating it is harmless: the second call finds no entry.
   *
   * It never calls 'recordDecision'. A withdrawn ticket therefore leaves NO audit row, and nothing
   * anywhere claims a human rejected it: "no decision" is the truthful state of an abandoned ask.
   * Other tickets are untouched — the loop-free body only ever addresses 'authorizationId'.
   *
   * 'inputDigest' is accepted for symmetry with 'decide', but it is NOT required and NOT checked:
   * the caller is the host that just abandoned this exact ask, and the id is already the whole
   * identity of one ticket ('approveOperation' refuses a second ticket with the same id).
   */
  function withdraw(authorizationId) {
    try {
      if (typeof authorizationId !== 'string' || !ID.test(authorizationId)) return false;
      purgeExpired();
      return finish(authorizationId, false);
    } catch { return false; }
  }

  function close() {
    for (const id of pending.keys()) finish(id, false);
  }

  return Object.freeze({ approveOperation, listPending, decide, withdraw, close });
}
