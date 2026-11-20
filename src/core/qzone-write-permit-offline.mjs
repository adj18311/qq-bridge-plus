// C4 — the ONE-TIME WRITE PERMIT: the thing that makes a controlled write channel different
// from a general write proxy.
//
// THE PROBLEM THIS ANSWERS (Codex ruling, C4)
// -------------------------------------------
// `POST /api/qzone/onebot` is reached with a long-lived bearer token. If that endpoint would
// perform `send_qzone_msg` / `comment_qzone` / `like_qzone` for anyone holding the token, then the
// token alone turns the endpoint into a general write proxy: it would bypass the approval, the
// quota reservation and the B2 claim that live in the plugin process. A whitelist of actions does
// not help — a write is still a write.
//
// So a write request must carry evidence that ONE specific, ALREADY-APPROVED operation is being
// executed: a permit that
//   · is ISSUED only for an approved operation, bound to `(authorizationId, inputDigest)`;
//   · is CONSUMABLE exactly once — the second `consume` of the same permit is `false`, no matter
//     who asks;
//   · expires quickly (`ttlMs`), so a permit that was issued and never used cannot be replayed
//     from an old log or a stale queue;
//   · cannot be MOVED between operations: a permit for A refuses when presented for B, because
//     BOTH the id and the digest must match the ones the permit was minted with.
//
// ⚠️ WHAT THIS MODULE PROVES, AND WHAT IT DOES NOT
// -----------------------------------------------
// It proves: "a permit with this id was issued by this registry for this exact
// (authorizationId, inputDigest), has not been consumed, has not expired, and has now been
// consumed." That is the whole claim.
//   · It does NOT prove a human approved the operation. The ISSUER is trusted to have checked
//     that; this module only refuses to hand out a second chance at the same permit.
//   · It does NOT prove the platform call succeeded. Consumption happens BEFORE the send and is
//     never undone: an `unknown` outcome (a lost answer) leaves the permit spent, which is exactly
//     why nothing may retry it. Refunding a permit after a failure would turn "one approved
//     operation, at most one write" back into "one approval, as many writes as you can get".
//   · It is NOT a signature. The id is an opaque random string minted by THIS registry, and the
//     only way to present it is to hand it back. That is enough to stop a REPLAY, not a
//     compromised issuer. A hostile process that can call `issue` has whatever authority the
//     issuer had — out of scope, and stated rather than implied.
//   · It is NOT persistent. The registry lives in memory: a restart forgets every permit, so a
//     permit cannot survive a process boundary. That is the closed direction (a forgotten permit
//     can only refuse a write, never authorise one) and it is why "the bridge must hold the
//     registry in ITS process" is a design requirement, not a preference — see the note in
//     `UNWIRED` of `plugins/qzone-safe/host-assembly.mjs`.
//
// WHY THE STATE IS A MAP OF ID -> RECORD AND NOT A SET
// ----------------------------------------------------
// A consumed permit must stay DISTINGUISHABLE from one that never existed, for one reason only:
// the second `consume` of a spent permit has to answer `false` — which a Set of ids alone cannot
// express once the id is deleted. Keeping the tombstone (with `consumedAt`) makes "already used"
// a durable fact for the life of the TTL, and `revoke`/`prune` are what finally drop it.

import { randomBytes } from 'node:crypto';

/** Same charset the authorizer uses for an id it mints (`qzone-operation-authorization-offline.mjs`). */
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** `inputDigest` is `sha256` hex, as the authorizer and the write-audit frame both produce it. */
const DIGEST = /^[a-f0-9]{64}$/;
/** A permit's own id: an opaque random token, never derived from the operation. */
const PERMIT_ID = /^[A-Za-z0-9_-]{1,128}$/;

const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 300_000;
const DEFAULT_CAPACITY = 64;
const MAX_CAPACITY = 4_096;

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Read one own DATA property without running a getter. Returns `undefined` for anything else. */
function ownData(target, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a permit registry.
 *
 * @param {object} options
 * @param {() => number} options.clock   trusted clock (integer milliseconds). Read on every issue
 *   and every consume: a permit's expiry is judged at the moment it is presented, not when it was
 *   minted.
 * @param {number} [options.ttlMs]      how long a permit stays usable, 1..300000 (default 30000 —
 *   the same budget the operation itself has, `qzone-operation-authorization-offline.mjs:59`).
 * @param {number} [options.capacity]   how many permits may be outstanding, 1..4096 (default 64).
 *   Reaching the cap REFUSES new issuance; it never evicts a live permit, because an evicted permit
 *   is a write that was approved and can no longer happen — and a silently dropped one is
 *   indistinguishable from a forged one.
 * @returns a frozen `{ issue, consume, revoke, size, ttlMs, capacity }`.
 * @throws {TypeError} on a missing or mistyped dependency. No default is invented for the clock.
 */
export function createQzoneWritePermitRegistry({ clock, ttlMs = DEFAULT_TTL_MS, capacity = DEFAULT_CAPACITY } = {}) {
  if (typeof clock !== 'function') throw new TypeError('write permit registry needs a clock function');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw new TypeError('write permit registry needs a ttlMs between 1 and ' + MAX_TTL_MS);
  }
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    throw new TypeError('write permit registry needs a capacity between 1 and ' + MAX_CAPACITY);
  }

  /** permitId -> { authorizationId, inputDigest, expiresAt, consumedAt } */
  const permits = new Map();

  /** Trusted `now`, or `null` when the clock misbehaves (every caller treats null as "refuse"). */
  function now() {
    try {
      const value = clock();
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  }

  /** Drop every entry that can no longer be consumed (expired or spent). Never drops a live one. */
  function prune(at) {
    for (const [id, record] of permits) {
      if (record.consumedAt !== null) { permits.delete(id); continue; }
      if (at >= record.expiresAt) permits.delete(id);
    }
  }

  /**
   * Mint one permit for an APPROVED operation.
   *
   * @param {{authorizationId: string, inputDigest: string}} binding  the exact pair the permit may
   *   later be consumed for. Both are taken from the approved operation, never from a caller's
   *   convenience copy: the digest is what binds the permit to the BODY that was approved.
   * @returns {string|null} the opaque permit id, or `null` for any refusal (bad binding, dead
   *   clock, capacity full). Never throws: an issuer that throws is an issuer a caller has to
   *   guess about, and every caller here has one closed answer anyway.
   */
  function issue(binding) {
    if (!isPlainRecord(binding)) return null;
    const authorizationId = ownData(binding, 'authorizationId');
    const inputDigest = ownData(binding, 'inputDigest');
    if (typeof authorizationId !== 'string' || !ID.test(authorizationId)) return null;
    if (typeof inputDigest !== 'string' || !DIGEST.test(inputDigest)) return null;
    const at = now();
    if (at === null) return null;

    // Reclaim dead entries first: they can never be consumed, so dropping them cannot lose a write.
    prune(at);
    if (permits.size >= capacity) return null;

    const permitId = randomToken();
    permits.set(permitId, {
      authorizationId,
      inputDigest,
      expiresAt: at + ttlMs,
      consumedAt: null,
    });
    return permitId;
  }

  /**
   * Spend one permit. Strict `true` is the ONLY answer that may release a write.
   *
   * Refused (all `false`, never a throw): a malformed request, an unknown id, an expired permit, a
   * permit already consumed, and either binding half not matching the one it was minted with.
   *
   * A BINDING MISMATCH DOES NOT BURN THE PERMIT. Burning on a wrong guess would let anyone who can
   * reach this object destroy a legitimate approved write by presenting a bogus digest; guessing
   * the right 256-bit digest is not a threat this layer can or should price in. A CONSUMED permit
   * is different: it is spent forever, by design.
   */
  function consume(request) {
    if (!isPlainRecord(request)) return false;
    const permitId = ownData(request, 'permitId');
    const authorizationId = ownData(request, 'authorizationId');
    const inputDigest = ownData(request, 'inputDigest');
    if (typeof permitId !== 'string' || !PERMIT_ID.test(permitId)) return false;
    if (typeof authorizationId !== 'string' || !ID.test(authorizationId)) return false;
    if (typeof inputDigest !== 'string' || !DIGEST.test(inputDigest)) return false;
    const at = now();
    if (at === null) return false;

    const record = permits.get(permitId);
    if (record === undefined) return false;
    if (record.consumedAt !== null) return false;
    if (at >= record.expiresAt) {
      // Expired is dead: drop it so `size()` cannot keep reporting a permit nobody can use.
      permits.delete(permitId);
      return false;
    }
    if (record.authorizationId !== authorizationId) return false;
    if (record.inputDigest !== inputDigest) return false;

    // Spent BEFORE the caller does anything with the answer, so a throwing transport cannot
    // leave a live permit behind for a retry.
    record.consumedAt = at;
    return true;
  }

  /**
   * Withdraw a permit that will never be used (an approved operation that failed before the send).
   *
   * @returns {boolean} `true` when this call removed a permit that still existed, `false` when the
   *   id was already gone (revoked, consumed-and-pruned, expired-and-pruned, or never issued).
   *   The STATE is idempotent either way: after any number of calls the permit is not usable.
   */
  function revoke(permitId) {
    if (typeof permitId !== 'string' || !PERMIT_ID.test(permitId)) return false;
    return permits.delete(permitId);
  }

  /** How many permits are still consumable right now (spent and expired ones do not count). */
  function size() {
    const at = now();
    if (at === null) return 0;
    let live = 0;
    for (const record of permits.values()) {
      if (record.consumedAt === null && at < record.expiresAt) live += 1;
    }
    return live;
  }

  return Object.freeze({ issue, consume, revoke, size, ttlMs, capacity });
}

/**
 * Wrap a platform transport so every write must first SPEND a one-time permit.
 *
 * THIS IS THE WHOLE INTEGRATION, in one place, so the assembly and the tests cannot drift:
 *   resolveBinding(payload)  asks the caller where the APPROVED (authorizationId, inputDigest)
 *                            pair for this dispatch is. Returning null means "no approval on
 *                            record" and the write is refused WITHOUT a permit ever existing.
 *   issue -> consume          the permit is minted and spent BEFORE the transport runs. A spend
 *                            failure revokes the doomed permit and refuses.
 *   transport(payload)       reached only after a successful spend, and exactly once: there is no
 *                            retry anywhere in this wrapper, because the permit it would need has
 *                            already been used.
 *
 * The refusal shape is `{ notSent: true, reason }` — the ONE shape the write path classifies as
 * "provably never left this process" (`qzone-write-settlement-offline.mjs:105-151`), so a refusal
 * can never be mistaken for "it may have gone out".
 *
 * ⚠️ IT DOES NOT REFUND THE QUOTA UNIT. The write path calls its transport AFTER the reservation
 * (`qzone-write-path-offline.mjs:932-947`), and nothing refunds after that point — so the caller
 * receives `stage:'transport'`, `outcome:'not-sent'`, `quotaConsumed:true`. That is the SAME
 * trade-off the codebase already accepts for every post-reservation refusal, and the honest
 * alternative (moving the permit exchange in front of the reservation) belongs to the write path,
 * not to this wrapper. Test C4-04 pins the cost rather than hiding it.
 *
 * @param {object} options
 * @param {{issue: Function, consume: Function, revoke?: Function}} options.writePermit
 * @param {(payload: object) => ({authorizationId: string, inputDigest: string}|null)} options.resolveBinding
 * @param {(payload: object) => Promise<unknown>} options.transport
 * @returns {(payload: object) => Promise<unknown>}
 * @throws {TypeError} when any dependency is missing or mistyped.
 */
export function createPermitGatedTransport({ writePermit, resolveBinding, transport } = {}) {
  if (writePermit === null || typeof writePermit !== 'object'
      || typeof writePermit.issue !== 'function' || typeof writePermit.consume !== 'function') {
    throw new TypeError('permit-gated transport needs a registry with issue/consume');
  }
  if (typeof resolveBinding !== 'function') {
    throw new TypeError('permit-gated transport needs a resolveBinding function');
  }
  if (typeof transport !== 'function') {
    throw new TypeError('permit-gated transport needs a transport function');
  }

  return async function permitGatedTransport(payload) {
    let binding = null;
    try {
      binding = resolveBinding(payload);
    } catch {
      binding = null;
    }
    const authorizationId = binding?.authorizationId;
    const inputDigest = binding?.inputDigest;
    if (typeof authorizationId !== 'string' || typeof inputDigest !== 'string') {
      return { notSent: true, reason: 'write-permit-unapproved' };
    }

    const permitId = writePermit.issue({ authorizationId, inputDigest });
    if (typeof permitId !== 'string' || permitId.length === 0) {
      return { notSent: true, reason: 'write-permit-unavailable' };
    }
    const spent = writePermit.consume({ permitId, authorizationId, inputDigest });
    if (spent !== true) {
      try { writePermit.revoke?.(permitId); } catch { /* a doomed permit cannot be used */ }
      return { notSent: true, reason: 'write-permit-refused' };
    }
    // Spent. Whatever happens below, this approved operation has no second permit.
    return transport(payload);
  };
}

/** An opaque, unguessable permit id: 16 CSPRNG bytes, hex-encoded. */
function randomToken() {
  // 16 bytes of CSPRNG entropy rendered as 32 hex characters: the id itself carries no meaning,
  // which is what makes "present the id" the only way to use a permit.
  return randomBytes(16).toString('hex');
}
