import { randomUUID } from 'node:crypto';
import { createQzoneOriginLedger } from './qzone-origin-ledger-offline.mjs';

// Offline lifecycle ownership only: this does not authenticate identity, IPC,
// connection events, or callers. The trusted caller must rotate on every
// reconnect and account change and enforce the actual source boundary.
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const validLimit = (n) => Number.isSafeInteger(n) && n >= 1 && n <= 4096;

export function createQzoneSourceLifetime(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('invalid source lifetime options');
  }
  const { sessionLimit = 256, trackingLimit = 4096 } = options;
  if (!validLimit(sessionLimit) || !validLimit(trackingLimit)) throw new TypeError('invalid source lifetime limits');

  let epoch = randomUUID();
  let closed = false;
  const ledgers = new Map();

  function retire() {
    // Block new access before revocation. All operations here are synchronous.
    closed = true;
    epoch = null;
    for (const ledger of ledgers.values()) ledger.disconnect();
    ledgers.clear();
  }

  return Object.freeze({
    sourceEpoch: () => epoch,
    ownsConsumption(value) {
      if (closed || !value || typeof value !== 'object' || value.epoch !== epoch || typeof value.sessionId !== 'string') return false;
      const ledger = ledgers.get(value.sessionId);
      return Boolean(ledger?.ownsConsumption(value));
    },
    getLedger(sessionId) {
      if (closed) throw new Error('source lifetime closed');
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new TypeError('invalid sessionId');
      const existing = ledgers.get(sessionId);
      if (existing) return existing;
      if (ledgers.size >= sessionLimit) throw new Error('source session limit reached');
      // Freezing prevents consumers from replacing disconnect on the owned
      // ledger; reconnect already remains permanently fail-closed after retire.
      const ledger = Object.freeze(createQzoneOriginLedger({ sessionId, epoch, trackingLimit }));
      ledgers.set(sessionId, ledger);
      return ledger;
    },
    rotate() {
      if (closed) throw new Error('source lifetime closed');
      retire();
      // If randomness fails the old ledgers remain revoked and owner closed.
      epoch = randomUUID();
      closed = false;
      return epoch;
    },
    // Per-session revocation. Strictly WEAKER than `rotate()` (which revokes every
    // session in the generation), so it grants no capability the caller did not
    // already have; it exists because generation-wide rotation is the wrong
    // granularity for a single session ending.
    //
    // The gap it closes: `getLedger` returns the SAME frozen ledger for a session
    // forever, so once a ledger lost continuity (its adapter's `dispose()` disconnects
    // it on `agent/disposed`) every later `agent/created` for that same session got the
    // poisoned ledger handed back to it. The new adapter then reported ready and every
    // dispatch failed `origin-unbound`, permanently, across plugin reloads — a clean
    // shutdown and resume was enough to trigger it.
    //
    // Returns true when a ledger was dropped. The disconnected object is unreachable
    // from here afterwards, so any consumption minted from it stops satisfying
    // `ownsConsumption` (that reads the map). Callers must NOT use this to recover
    // from a runtime fault: a disconnect means ordering evidence was lost, and only a
    // clean lifecycle boundary (the session really ended) may start over.
    invalidate(sessionId) {
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new TypeError('invalid sessionId');
      const ledger = ledgers.get(sessionId);
      if (!ledger) return false;
      ledgers.delete(sessionId);
      try { ledger.disconnect(); } catch {}
      return true;
    },
    close() { if (!closed) retire(); },
  });
}
