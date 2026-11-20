import { bindQzoneConnectionEpoch } from './qzone-connection-epoch-runtime.mjs';
import { createQzoneAccountIdentityGuard } from './qzone-account-identity-offline.mjs';
import { createQzoneSourceLifetime } from './qzone-source-lifetime-offline.mjs';

// Offline composition only: caller owns the client and must provide an
// authenticated, same-connection transport and trusted event boundary before
// any production use. This module never invokes connect().
export function createQzoneConnectionSourceCoordinator({ client, expectedUserId, sessionLimit, trackingLimit } = {}) {
  if (!client || typeof client.on !== 'function' || typeof client.use !== 'function' || typeof client.getLoginInfo !== 'function' ||
      (typeof client.off !== 'function' && typeof client.removeListener !== 'function') ||
      !Array.isArray(client.middlewares) || client.middlewares.length !== 0 ||
      !Number.isSafeInteger(expectedUserId) || expectedUserId <= 0) throw new TypeError('invalid coordinator dependencies');
  const sources = createQzoneSourceLifetime({ sessionLimit, trackingLimit });
  // Listener registration order is significant: tracker updates before guard.
  const tracker = bindQzoneConnectionEpoch(client);
  const identity = createQzoneAccountIdentityGuard({ client, getEpoch: tracker.current, expectedUserId });
  let disposed = false, ready = false, conflict = false, revision = 0, broken = false;

  function revoke() {
    ready = false;
    revision++;
    if (disposed || broken) return;
    try { sources.rotate(); } catch { broken = true; sources.close(); }
  }
  function onOpen() { revoke(); conflict = false; }
  function onDisconnect() { revoke(); }
  const validId = (id) => Number.isSafeInteger(id) && id > 0;
  function observeEvent(event) {
    if (disposed || broken) return false;
    // Require identity on every event packet, not just message events. The
    // SDK event listener is post-middleware; callers may invoke this earlier.
    const valid = event !== null && typeof event === 'object' && !Array.isArray(event) &&
      typeof event.post_type === 'string' && event.post_type.length > 0 &&
      Object.hasOwn(event, 'self_id') && validId(event.self_id) && event.self_id === expectedUserId &&
      (!(event.post_type === 'notice' && event.notice_type === 'bot_status') ||
        (validId(event.user_id) && event.user_id === event.self_id && event.sub_type === 'online'));
    if (!valid) {
      conflict = true;
      revoke();
      return false;
    }
    return identity.observeEvent(event) && isReady();
  }
  function isReady() {
    return !disposed && !broken && !conflict && ready && tracker.current() >= 0 && identity.isVerified();
  }
  async function verify() {
    if (disposed || broken || conflict || tracker.current() < 0) return false;
    revoke();
    if (broken) return false;
    const ticket = revision;
    const verified = await identity.verify();
    if (disposed || broken || conflict || ticket !== revision || !verified || !identity.isVerified() || tracker.current() < 0) return false;
    ready = true;
    return true;
  }
  async function refreshIdentity() {
    if (!isReady()) return false;
    // A successful later identity query cannot prove identity continuity while
    // it was pending. Retire all prior sources and require new registrations.
    return verify();
  }
  // When the SDK exposes middleware, observe identity before subsequently
  // registered business handlers. A conflict only disables QZone access; it
  // must not suppress ordinary QQ messages. Production must install this
  // coordinator before registering its own handlers.
  let disposeMiddleware = null;
  if (typeof client.use === 'function') {
    try {
      disposeMiddleware = client.use(async (event, _context, next) => {
        try { observeEvent(event); } catch { conflict = true; revoke(); }
        return next();
      });
      if (typeof disposeMiddleware !== 'function') throw new Error('middleware is not disposable');
    } catch (error) {
      sources.close(); identity.close(); tracker.close();
      throw error;
    }
  }
  client.on('open', onOpen);
  client.on('close', onDisconnect);
  client.on('error', onDisconnect);
  client.on('event', observeEvent);
  const remove = typeof client.off === 'function' ? client.off.bind(client) : client.removeListener.bind(client);

  // ── Single-holder claim / release ────────────────────────────────────────────────
  //
  // WHY: this factory composes one client, one epoch tracker, one identity guard and one
  // source lifetime. Two independent assemblies over the SAME coordinator would each
  // install their own guard on one event stream and rotate each other's sources, so
  // "who owns this coordinator" has to be answerable and enforceable, not assumed.
  //
  // WHAT IT IS NOT: a testable MECHANISM, not a production enforcement point. Nothing on
  // the production path calls `claim()`; the assembly entry that must mandate it is a
  // separate wiring task. Putting the check into `createQzonePluginHandle` would change
  // the plugin handshake and break the offline suites for no security gain, so it is
  // deliberately absent (see `scripts/test-qzone-coordinator-claim.mjs`).
  //
  // ATOMICITY: `claim()` is SYNCHRONOUS and has no `await` between "is it free?" and the
  // write, so no caller can be preempted in between and two racing claims cannot both
  // observe `holder === null`. Do not make it async and do not split check from assign.
  let holder = null;
  const validToken = (token) => typeof token === 'string' && token.length > 0;
  const claim = (token) => {
    if (disposed) return { ok: false, reason: 'coordinator-disposed' };
    if (!validToken(token)) return { ok: false, reason: 'invalid-token' };
    if (holder !== null) {
      // A repeat claim by the CURRENT holder is REJECTED, not made idempotent. Claim is
      // meant to be paired with `release` in a `finally`; a second success would let one
      // `release()` open the door while the second claimant still believes it holds the
      // coordinator. The two reasons stay distinct so the diagnosis is unambiguous:
      // same token = a lost release, different token = a genuine second assembly.
      return { ok: false, reason: holder === token ? 'already-held-by-same-token' : 'held-by-another-holder' };
    }
    holder = token;
    return { ok: true };
  };
  const release = (token) => {
    if (!validToken(token)) return { ok: false, reason: 'invalid-token' };
    if (holder === null) return { ok: false, reason: 'not-held' };
    // Token-checked: a stale or foreign token must not free the coordinator for the real
    // holder, otherwise release becomes an unauthenticated reset.
    if (holder !== token) return { ok: false, reason: 'held-by-another-holder' };
    holder = null;
    return { ok: true };
  };

  return Object.freeze({
    verify, refreshIdentity, isReady, observeEvent,
    claim,
    release,
    // Read-only occupant, so a caller can diagnose without having to claim first.
    holder: () => holder,
    // Failure cleanup, made structural: the claim is released on the throwing path too,
    // so an exception inside the owned work cannot leak the occupancy. The claim itself
    // is taken synchronously before the first `await`, which is what keeps it atomic.
    async withClaim(token, run) {
      if (typeof run !== 'function') throw new TypeError('withClaim requires a function');
      const claimed = claim(token);
      if (!claimed.ok) {
        const error = new Error(`coordinator claim refused: ${claimed.reason}`);
        error.code = claimed.reason;
        throw error;
      }
      try { return await run(); } finally { release(token); }
    },
    connectionEpoch: () => disposed ? -1 : tracker.current(),
    accountId: () => isReady() ? identity.accountId() : null,
    sourceEpoch: () => isReady() ? sources.sourceEpoch() : null,
    getLedger(sessionId) {
      if (!isReady()) throw new Error('source unavailable');
      return sources.getLedger(sessionId);
    },
    // Per-session revocation MUST be forwarded, not omitted.
    //
    // The plugin's `releaseLedger()` calls `sourceLifetime.invalidate?.(sessionId)` on a
    // clean `agent/disposed` so a later resume of the same session can mint a fresh
    // ledger. `getLedger` hands back the SAME frozen ledger forever, so without this the
    // disconnected ledger stays in `sources` and every resume gets it back: the plugin
    // sees `alive() === false`, refuses to install an adapter (`adaptersBlocked`), and
    // the session can never dispatch again until the connection is re-established.
    //
    // The optional chaining on the plugin side makes this failure SILENT: a facade
    // without `invalidate` looks wired while the only recovery path is a no-op. This is
    // why the coordinator — the shape actually injected in
    // `scripts/test-qzone-real-host-offline-chain.mjs` — must expose it too.
    //
    // Strictly WEAKER than `revoke()`/`rotate()`: it drops one session's ledger without
    // changing the generation, so it cannot strand other sessions. It is gated on
    // `isReady()` for the same reason `getLedger` is: when the source is unavailable
    // there is nothing trustworthy to revoke, and the caller must rotate instead.
    invalidate(sessionId) {
      if (!isReady()) return false;
      return sources.invalidate(sessionId);
    },
    ownsConsumption(value) { return isReady() && sources.ownsConsumption(value); },
    dispose() {
      if (disposed) return;
      disposed = true; ready = false; revision++;
      // Drop the occupancy: a disposed coordinator is not "held", and leaving a stale
      // token behind would make `holder()` lie after teardown (the claim itself refuses
      // on `disposed`, so this is about honest readability, not about re-entry).
      holder = null;
      sources.close();
      if (disposeMiddleware) { try { disposeMiddleware(); } catch {} }
      remove('open', onOpen); remove('close', onDisconnect);
      remove('error', onDisconnect); remove('event', observeEvent);
      identity.close(); tracker.close();
    },
  });
}
