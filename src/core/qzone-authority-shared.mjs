// Send AUTHORITY resolution — one place that answers "which in-process authority is this store?".
//
// WHY THIS MODULE EXISTS (t9, measured)
// -------------------------------------
// The fault latch (M4) is bucketed by send authority, and the authority is minted by the store module
// (`qzone-store-offline.mjs: authorityOf`). Two components need to agree on it:
//   · `qzone-write-path-offline.mjs`  — refuses new writes when the authority is latched;
//   · `qzone-write-observability-offline.mjs` — latches the authority when a commit/settlement fails.
// Before this module, each resolved the authority itself, so a delegating wrapper on one side and a
// bare handle on the other landed on DIFFERENT authorities and the fault was invisible. Measured
// (CHAIN-6's shape, `{read, update}` closure over a real handle): the latch was set through the
// wrapper and the write still went out — `{latched:true, ok:true, transportCalls:1}`.
//
// NO SILENT FALLBACK (Codex ruling, R6-2026-11-14)
// ------------------------------------------------
// The first version returned the caller's handle when a store carried no authority. That made every
// unknown handle its OWN authority — so a closure wrapper over a real store latched a fault the real
// store never saw, and the write still went out. A fail-open, reached through a different shape than
// F-M4-1 but the same direction.
//
// Now an unbound handle has NO authority, and the factories REFUSE it at construction time
// (`requireAuthority`). Fail-closed beats guessing: a wrapper that cannot name its database must not be
// allowed to pretend it can.
//
// THE DECLARATION ESCAPE HATCH IS GONE (Codex CODEX-TEST-SEAM-CLOSE-20261114 §A)
// ----------------------------------------------------------------------------
// This module used to export `declareOfflineTestDouble(handle)` — mint a fresh authority for ANY
// object. Measured consequences (reviewer t14, reproduced here):
//   · a closure over a REAL store became its own authority again, so the two factories accepted it;
//   · a fault latched on it was invisible to the real handle;
//   · a write issued through it still went out — and, worse, was charged to the REAL database's daily
//     quota (`used.like` 0→1, reservation id kept forever), i.e. the real authority's refusal was
//     bypassed and its budget spent.
// That is the R6 fail-open rebuilt from the outside, so it is removed rather than documented.
//
// WHAT REPLACES IT — delegating wrappers that CARRY THE REAL AUTHORITY
// -------------------------------------------------------------------
// Offline tests still need to intercept `update` (to fail a commit, count transactions, race a write).
// The supported shape is a SPREAD of the real handle:
//
//     const store = { ...real, update(fn) { if (boom) throw new Error('disk full'); return real.update(fn); } };
//
// `{ ...real }` copies the handle's own enumerable `authority` property, so the wrapper is the SAME
// authority as the database it wraps — the latch is shared, and the fault the wrapper triggers is the
// one the real handle sees. Nothing is minted; nothing can be split.
//
// A hand-written `{read, update}` double that backs no store therefore has no authority and is refused.
// Tests that truly need one open a temporary real store instead (that is a real authority with real
// state, which is what most of them were emulating anyway).
//
// WHY NOT BUCKET BY OBJECT: two handles opened on one database file are distinct objects. Bucketing by
// the object treats them as two send authorities, so latching one leaves the other free to send.
// `authorityOf` fixes that by keying on the canonical file (LZ-7d/7e).
//
// L-3 IS UNCHANGED: this is PROCESS-LOCAL. Nothing here is persisted, so a restart starts with an
// empty latch. An empty latch is NOT "healthy" — the gate still reads `state.writeGate` /
// `state.auditGaps`, which is what a restart must re-derive health from (L-5).
//
// HANDLE ROTATION IS NOT A RESTART: closing the last handle on a file and reopening it does NOT mint a
// new authority (see `qzone-store-offline.mjs` → `retiredByKey`). Otherwise one `close()` would
// launder a live fault.

import { authorityOf } from './qzone-store-offline.mjs';

/**
 * The authority this handle belongs to, or `null` when it carries none.
 *
 * Never falls back to the object: an unbound handle has no authority, and pretending otherwise is the
 * exact fail-open this module exists to remove. There is no registration path either — a token can only
 * come from a store handle (`openOfflineStore`) or a spread wrapper that carries one of those tokens.
 *
 * @param store - a store handle, or a spread wrapper of one.
 * @returns a frozen token, or `null`.
 */
export function resolveAuthority(store) {
  if (!store || typeof store !== 'object') return null;
  return authorityOf(store);
}

/**
 * The authority, or a thrown `TypeError` naming the caller — construction-time refusal for factories.
 *
 * @param store - the handle to resolve.
 * @param what  - who is refusing, for the message (e.g. `'offline write path'`).
 * @returns the authority token.
 * @throws {TypeError} when the handle carries no authority (closure wrapper over a store, or a
 *   hand-built double with no backing database).
 */
export function requireAuthority(store, what) {
  const authority = resolveAuthority(store);
  if (authority === null) {
    const who = typeof what === 'string' && what ? what : 'offline component';
    throw new TypeError(
      `${who} needs a store with a send authority: pass the handle returned by openOfflineStore, ` +
      'or a SPREAD wrapper of it that keeps the authority property (`{ ...store, update }`). ' +
      'A closure cannot name its database, so it would silently become its own authority — refuse ' +
      'rather than guess. There is no way to declare an arbitrary object as an authority.',
    );
  }
  return authority;
}
