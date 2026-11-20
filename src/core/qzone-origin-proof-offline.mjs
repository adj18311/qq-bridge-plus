// B3 sample: request-level capability issued and verified on the TRUSTED side (B).
//
// Scope of this module — read this before claiming anything about B3
// ------------------------------------------------------------------
// This implements a REQUEST-LEVEL capability: the trusted side signs a proof over a tuple of
// fields describing a QQ inbound event, and verifies that proof when a tool call arrives.
//
// It does NOT prove that a specific tool call really happened inside DSH, and it does NOT
// prove the fields describe a real QQ event. Two separate gaps, both measured:
//
//   1. `issue()` trusts its caller. Passing `sourceKind:'synthetic-event'` and
//      `sourceMessageId:'not-a-real-event'` produces a proof that verifies. Binding to a REAL
//      event depends on a trusted inbound channel on the B side, which this sample does not
//      have. So say "signed over caller-supplied fields", never "signed from a real QQ event".
//
//   2. A holder of a valid proof can still fabricate a fresh `callId` with its own
//      `turn`/`step` — nothing in a symmetric MAC binds "this exact call happened in the
//      native pipeline". Measured by `scripts/test-qzone-b3-origin.mjs` case FANOUT.
//
// Verdict for this sample: "request-scope capability enforced" — NOT "native call chain
// closed", NOT "real-event binding proven".
//
// callId is therefore NOT part of the signed material; it is a de-duplication handle recorded
// on the verifying side, because the initial proof is issued before any callId exists.
//
// Revocation and registration
// ---------------------------
// `issue()` and `remember()` are joined by a shared issuance registry held on the trusted side.
// The registry records the generation AT ISSUE TIME, and `remember()` copies that generation
// rather than the current one. That closes the hole where re-registering an old proof after
// `revokeAll()` used to revive it:
//
//     issue -> remember -> revokeAll -> verify = revoked -> remember(old) -> verify = PASSED
//
// Only the raw `{requestId -> generation}` record from issuance can make a proof verifiable,
// and re-registering can never refresh it. Registration is idempotent on purpose.
//
// What this is NOT: authentication of the delivering process, proof of native invocation, or
// an external API. `issue`/`remember` are trusted-internal entry points.

import { createHmac, createHash, timingSafeEqual, randomUUID } from 'node:crypto';

/** Proof wire format version. */
export const PROOF_VERSION = 1;
/** Default validity window for a request-level proof. */
export const DEFAULT_PROOF_TTL_MS = 10 * 60 * 1000;

const NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Domain separator + encoding revision for the signed material.
 *
 * The material used to be the field values joined with NUL. That is NOT an unambiguous
 * encoding: a NUL inside a value shifts the field boundary, so two different tuples produce
 * identical bytes. Measured:
 *
 *     issue({ sourceKind: 'private\u0000other', sourceId: '123', ... })
 *     -> alter to { sourceKind: 'private', sourceId: 'other\u0000123' }, keep the signature
 *     -> verify() returned ok:true and reported the ALTERED sourceKind/sourceId
 *
 * A sha256 of the joined string cannot help either: the digest is taken over the same
 * ambiguous bytes, so both tuples hash identically.
 *
 * Fix: sign a JSON array (fixed order, explicit types) prefixed by this domain string.
 * JSON escapes interior NULs as `\u0000`, so the array is injective over string tuples and
 * numbers stay numbers (`accountId: 111` can never collide with the string `"111"`).
 *
 * NOTHING in this sample is deployed, so there is no migration: no proof signed with the old
 * encoding exists outside these tests. Do not describe this as a live format migration.
 */
const MATERIAL_DOMAIN = 'qzone-origin-proof/v2';

/**
 * Canonical signed material. Every one of issue / remember / verify MUST use this exact
 * function — a divergence here is precisely how the ambiguity would come back.
 *
 * @param {object} f - proof-shaped object with v, accountId, sourceKind, sourceId,
 *   sourceMessageId, requestId, scope, issuedAt, expiresAt, nonce
 * @returns {string} deterministic, unambiguous
 */
export function materialOf(f) {
  // Fixed order, explicit types. Do not accept extra fields into the tuple: the contract is
  // these nine values, and silently widening it would change what a signature means.
  return JSON.stringify([
    MATERIAL_DOMAIN,
    f.v,
    f.accountId,
    f.sourceKind,
    f.sourceId,
    f.sourceMessageId,
    f.requestId,
    f.scope,
    f.issuedAt,
    f.expiresAt,
    f.nonce,
  ]);
}

/**
 * Trusted-side issuance record shared by the issuer and the verifier.
 *
 * It lives on the B side and is deliberately NOT derivable from the proof itself: the proof
 * carries no generation field, so a forger cannot claim an older/newer generation.
 */
export function createIssuanceRegistry() {
  /** requestId -> frozen { scope, sourceKind, sourceId, sourceMessageId, expiresAt, issuedAt, issuedGeneration } */
  const records = new Map();
  /**
   * The revocation generation lives HERE, on the trusted side, so the issuer and the verifier
   * cannot disagree about it. With two separate counters a fresh issuance after `revokeAll()`
   * was stamped with the old generation and was rejected — measured in this sample before the
   * counter was shared.
   */
  let generation = 0;
  return Object.freeze({
    /**
     * Record an issuance. `record.materialDigest` is the sha256 of the EXACT signed string, so
     * a later `remember()` can demand byte-identical binding rather than spot-checking a few
     * fields. Without it, `{...proof, nonce:'different', signature:'invalid'}` was accepted by
     * `remember()` (measured): it only compared 6 fields, so any object carrying the right
     * requestId could pre-register the slot even with a broken signature.
     */
    put(requestId, record) {
      if (records.has(requestId)) return false;   // first issuance wins; never refreshed
      records.set(requestId, Object.freeze({ ...record }));
      return true;
    },
    get(requestId) { return records.get(requestId); },
    delete(requestId) { return records.delete(requestId); },
    size() { return records.size; },
    /** Current revocation generation. Proofs are only valid against the one they were issued in. */
    generation: () => generation,
    /** Invalidate every outstanding proof; later issuances get the new generation. */
    revokeAll() { generation += 1; return generation; },
  });
}

/**
 * TRUSTED SIDE. Holds the MAC key. Never hands it out.
 *
 * @param accountId - the bot's own uin; part of every proof so one account's proof cannot be
 *   replayed as another's.
 * @param secret - Buffer of at least 32 bytes, trusted component only.
 * @param registry - shared with the verifier; records issuance generation.
 * @param currentGeneration - optional ()=>number; defaults to 0 and is used to stamp the
 *   generation at issue time. Production would share the verifier's revocation counter.
 */
export function createProofIssuer({ accountId, secret, registry, currentGeneration } = {}) {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new TypeError('issuer needs a positive accountId');
  }
  if (!Buffer.isBuffer(secret) || secret.length < 32) {
    throw new TypeError('issuer needs a secret Buffer of at least 32 bytes');
  }
  if (!registry || typeof registry.put !== 'function') {
    throw new TypeError('issuer needs an issuance registry (trusted-side record)');
  }
  const gen = typeof currentGeneration === 'function' ? currentGeneration : () => registry.generation();
  const mac = (material) => createHmac('sha256', secret).update(material).digest();

  return Object.freeze({
    accountId,

    /**
     * Sign a proof over the fields the CALLER supplied.
     *
     * This function does NOT verify that those fields describe a real QQ event — that requires
     * a trusted inbound channel. Do not describe its output as "signed from a real event".
     */
    issue({ sourceKind, sourceId, sourceMessageId, requestId, scope, issuedAt, ttlMs = DEFAULT_PROOF_TTL_MS, nonce } = {}) {
      if (typeof sourceKind !== 'string' || !sourceKind) throw new TypeError('sourceKind required');
      if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId required');
      if (typeof sourceMessageId !== 'string' || !sourceMessageId) throw new TypeError('sourceMessageId required');
      if (typeof requestId !== 'string' || !requestId) throw new TypeError('requestId required');
      if (typeof scope !== 'string' || !scope) throw new TypeError('scope required');
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new TypeError('issuedAt required');
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be positive');

      const n = nonce ?? randomUUID();
      if (typeof n !== 'string' || !NONCE_RE.test(n)) throw new TypeError('nonce must be a uuid');

      const expiresAt = issuedAt + ttlMs;
      const payload = Object.freeze({
        v: PROOF_VERSION, accountId, sourceKind, sourceId, sourceMessageId, requestId, scope, issuedAt, expiresAt, nonce: n,
      });
      const material = materialOf({ ...payload, accountId });
      const proof = Object.freeze({ ...payload, signature: mac(material).toString('base64url') });

      // Record the generation AND the canonical signed material NOW. A later `remember()`
      // copies the generation (never the then-current value), so re-registering after a revoke
      // cannot revive the proof, and it demands the same material, so a different
      // nonce/signature/version cannot pre-register the slot.
      const recorded = registry.put(requestId, {
        scope, sourceKind, sourceId, sourceMessageId, expiresAt, issuedAt,
        issuedGeneration: gen(),
        materialDigest: createHash('sha256').update(material).digest('hex'),
      });
      if (recorded === false) throw new TypeError(`requestId already issued: ${requestId}`);
      return proof;
    },
  });
}

/**
 * TRUSTED SIDE. Holds the MAC key and the record of what has been consumed.
 */
export function createProofVerifier({ accountId, secret, clock, registry } = {}) {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new TypeError('verifier needs a positive accountId');
  }
  if (!Buffer.isBuffer(secret) || secret.length < 32) {
    throw new TypeError('verifier needs a secret Buffer of at least 32 bytes');
  }
  if (typeof clock !== 'function') throw new TypeError('verifier needs a clock()');
  if (!registry || typeof registry.get !== 'function') {
    throw new TypeError('verifier needs the issuance registry');
  }

  const mac = (material) => createHmac('sha256', secret).update(material).digest();

  /** requestId -> frozen registration (generation fixed at first registration) */
  const registered = new Map();
  /** `${requestId}\u0000${callId}` -> claimed */
  const consumedCalls = new Set();

  return Object.freeze({
    get revocationGeneration() { return registry.generation(); },

    /**
     * Register a proof for later delivery checks.
     *
     * Idempotent: the FIRST registration wins and re-registering can never refresh the
     * recorded generation or any other field. The generation comes from the issuance registry,
     * so an old proof cannot be made current again by calling this after `revokeAll()`.
     */
    remember(proof) {
      if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw new TypeError('proof required');
      const record = registry.get(proof.requestId);
      if (!record) {
        // Never issued by the trusted side (or the issuance was removed). Refuse rather than
        // accept an object that merely LOOKS like a proof.
        throw new TypeError(`proof was not issued by this trusted side: ${String(proof.requestId)}`);
      }

      // Compare against the EXACT signed material, not a spot-check of a few fields.
      //
      // Measured defect: `{...proof, nonce:'different', signature:'invalid'}` was accepted
      // because only 6 fields were compared, so a broken object could pre-register the slot
      // (registration count 0 -> 1) and make the original proof verifiable as a side effect.
      // Digests are compared as hex strings, so a JSON round trip of the SAME proof still
      // matches — nothing here depends on object identity or on a cross-process WeakSet.
      const deliveredVersion = proof.v;
      const deliveredAccount = proof.accountId;
      if (deliveredVersion !== PROOF_VERSION) throw new TypeError('proof v disagrees with the issuance record');
      if (deliveredAccount !== accountId) throw new TypeError('proof accountId disagrees with the issuance record');
      for (const k of ['scope', 'sourceKind', 'sourceId', 'sourceMessageId', 'expiresAt', 'issuedAt']) {
        if (proof[k] !== record[k]) throw new TypeError(`proof ${k} disagrees with the issuance record`);
      }
      if (typeof proof.nonce !== 'string' || !NONCE_RE.test(proof.nonce)) {
        throw new TypeError('proof nonce is missing or malformed');
      }
      if (typeof proof.signature !== 'string' || !proof.signature) {
        throw new TypeError('proof signature is missing');
      }

      // Canonical material must be byte-identical to what was signed at issuance.
      const deliveredDigest = createHash('sha256')
        .update(materialOf({ v: deliveredVersion, accountId: deliveredAccount, sourceKind: proof.sourceKind, sourceId: proof.sourceId, sourceMessageId: proof.sourceMessageId, requestId: proof.requestId, scope: proof.scope, issuedAt: proof.issuedAt, expiresAt: proof.expiresAt, nonce: proof.nonce }))
        .digest('hex');
      if (deliveredDigest !== record.materialDigest) {
        throw new TypeError('proof signed material disagrees with the issuance record');
      }

      // And the signature must actually verify, so a caller cannot register with a broken MAC.
      const expected = mac(materialOf({ v: deliveredVersion, accountId: deliveredAccount, sourceKind: proof.sourceKind, sourceId: proof.sourceId, sourceMessageId: proof.sourceMessageId, requestId: proof.requestId, scope: proof.scope, issuedAt: proof.issuedAt, expiresAt: proof.expiresAt, nonce: proof.nonce }));
      let supplied;
      try { supplied = Buffer.from(proof.signature, 'base64url'); } catch { throw new TypeError('proof signature is not base64url'); }
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw new TypeError('proof signature does not verify against the issuance record');
      }

      // First registration wins; re-registering can never refresh the generation.
      if (!registered.has(proof.requestId)) {
        registered.set(proof.requestId, Object.freeze({ ...record, generation: record.issuedGeneration }));
      }
      return proof.requestId;
    },

    /** Revoke everything issued so far. Every outstanding proof becomes invalid. */
    revokeAll() { return registry.revokeAll(); },

    /**
     * Verify a delivered proof.
     *
     * @returns {ok:true, requestId, scope, sourceKind, sourceId} | {ok:false, reason}
     */
    verify(proof) {
      if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return { ok: false, reason: 'proof-malformed' };
      const { v, accountId: acct, sourceKind, sourceId, sourceMessageId, requestId, scope, issuedAt, expiresAt, nonce, signature } = proof;
      if (v !== PROOF_VERSION) return { ok: false, reason: 'proof-version' };
      if (acct !== accountId) return { ok: false, reason: 'proof-account-mismatch' };
      for (const [name, val] of Object.entries({ sourceKind, sourceId, sourceMessageId, requestId, scope, nonce })) {
        if (typeof val !== 'string' || !val) return { ok: false, reason: `proof-field-${name}` };
      }
      if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
        return { ok: false, reason: 'proof-window-invalid' };
      }
      if (typeof signature !== 'string' || !signature) return { ok: false, reason: 'proof-signature-missing' };

      // Signature first: everything below assumes the bytes are authentic.
      const expected = mac(materialOf({ ...proof, accountId: acct }));
      let supplied;
      try { supplied = Buffer.from(signature, 'base64url'); } catch { return { ok: false, reason: 'proof-signature-encoding' }; }
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return { ok: false, reason: 'proof-signature-invalid' };
      }

      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0) return { ok: false, reason: 'clock-invalid' };
      if (now < issuedAt) return { ok: false, reason: 'proof-not-yet-valid' };
      if (now >= expiresAt) return { ok: false, reason: 'proof-expired' };

      const known = registered.get(requestId);
      if (!known) return { ok: false, reason: 'proof-unknown-request' };
      if (known.generation !== registry.generation()) return { ok: false, reason: 'proof-revoked' };

      return { ok: true, requestId, scope, sourceKind, sourceId };
    },

    /**
     * Verify a DELIVERY: proof + the call identity the caller claims.
     *
     * `callId` is only de-duplicated here. Nothing binds it to a native DSH event, so a holder
     * of a valid proof can present ANY fresh callId and this returns ok. Measured by FANOUT.
     */
    verifyDelivery({ proof, callId, turn, step, action, target } = {}) {
      const verified = this.verify(proof);
      if (!verified.ok) return verified;
      if (typeof callId !== 'string' || !callId) return { ok: false, reason: 'delivery-call-missing' };
      if (!Number.isSafeInteger(turn) || turn <= 0) return { ok: false, reason: 'delivery-turn-invalid' };
      if (!Number.isSafeInteger(step) || step <= 0) return { ok: false, reason: 'delivery-step-invalid' };

      if (typeof action !== 'string' || action !== verified.scope) {
        return { ok: false, reason: 'delivery-scope-violation', expected: verified.scope, got: action };
      }
      void target;

      const key = `${verified.requestId}\u0000${callId}`;
      if (consumedCalls.has(key)) return { ok: false, reason: 'delivery-call-already-consumed' };
      consumedCalls.add(key);
      return { ok: true, requestId: verified.requestId, scope: verified.scope, callId };
    },

    consumedCount() { return consumedCalls.size; },
    registeredCount() { return registered.size; },
  });
}
