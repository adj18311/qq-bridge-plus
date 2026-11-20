// Trusted binding minting for QZone reads. A binding is the only evidence the
// reader accepts that a tool call came from an origin-ledger-consumed step.
//
// Trust chain: the origin ledger issues a consumption object (WeakSet-recorded
// by isOriginLedgerConsumption); this gate mints a binding exactly once per
// consumption with a positive botQq/targetQq and a non-negative connectionEpoch.
// Nothing else can produce a binding: plain objects, copies, spreads, or JSON
// round-trips lack the module-private ticket and the WeakSet membership.
//
// ── WHICH ORIGINS THIS GATE ACCEPTS, AND WHY EACH IS TRUSTWORTHY ──────────────
//
// 'qq-inbound'  — the ledger registered this requestId because the BRIDGE received a real QQ
//                 message and is delivering it (bridge.js deliverPromptNow; origin is decided by
//                 `opts.backgroundPatrol === true ? 'schedule' : 'qq-inbound'`). The user is the
//                 source; the model cannot invent it.
//
// 'schedule'    — the requestId came from a background opportunity the bridge itself produced
//                 and is delivering. Adding it here is a SHAPE admission only: it says "a
//                 schedule consumption is well-formed", NOT "this schedule consumption may read
//                 the space".
//                 ⚠️ THE OFFER CHECK IS NOT HERE AND MUST NOT BE ADDED HERE. This gate has no
//                 store, so it cannot know whether an offer exists for this requestId. The caller
//                 (qzone-runtime-wiring.mjs authorizeBinding) performs it, and THAT check is what
//                 turns a schedule consumption into a proactive read. Without it, an arbitrary
//                 schedule delivery (another platform's patrol reusing this path) would gain
//                 QZone read access on the strength of the origin string alone.
//
// WHEN A NEW ORIGIN IS ADDED TO THE LEDGER'S CLOSED SET, THIS GATE MUST BE RE-EXAMINED. The
// question is never "does the string look right" but "what makes a consumption with this origin
// trustworthy, and who checks the part this gate cannot see".
//
// Offline-testable. The caller must still compare connectionEpoch with the live
// epoch via verify() before using a binding; a stale binding is rejected.
import { createHash } from 'node:crypto';
import { isOriginLedgerConsumption } from './qzone-origin-ledger-offline.mjs';

const TICKET = Symbol('qzone-trusted-binding-ticket');

/**
 * Ledger origins this gate will mint from. Closed on purpose — see the header note for what each
 * one vouches for and which part of its trust is checked ELSEWHERE.
 *
 * Adding a member here does NOT grant read access by itself: 'schedule' additionally requires an
 * offer hit in `authorizeBinding`. Keep that split when adding a third origin.
 */
const ACCEPTED_ORIGINS = new Set(['qq-inbound', 'schedule']);
const minted = new WeakSet();
const bindingSources = new WeakMap();
const spentConsumptions = new WeakSet();

const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonNegative = (value) => Number.isSafeInteger(value) && value >= 0;
const digest = (...parts) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);

function isTrusted(binding) {
  return binding !== null && typeof binding === 'object' && minted.has(binding) && binding[TICKET] === true &&
    isOriginLedgerConsumption(bindingSources.get(binding));
}

export function createQzoneTrustedBindingGate() {
  return Object.freeze({
    /**
     * Mint a binding from one ledger consumption. Returns null for anything else.
     * Each consumption can mint at most one binding.
     */
    mint({ consumption, connectionEpoch, botQq, targetQq } = {}) {
      if (!isOriginLedgerConsumption(consumption) || spentConsumptions.has(consumption)) return null;
      if (!ACCEPTED_ORIGINS.has(consumption.origin) || typeof consumption.requestId !== 'string' || !consumption.requestId ||
          typeof consumption.sessionId !== 'string' || !consumption.sessionId ||
          typeof consumption.epoch !== 'string' || !consumption.epoch ||
          !positive(consumption.turn) || !positive(consumption.step) ||
          typeof consumption.callId !== 'string' || !consumption.callId) return null;
      if (!nonNegative(connectionEpoch) || !positive(botQq) || !positive(targetQq)) return null;

      spentConsumptions.add(consumption);
      const referenceId = digest(consumption.sessionId, consumption.callId,
        String(consumption.turn), String(consumption.step), consumption.requestId);
      const binding = {
        [TICKET]: true,
        referenceId,
        sourceProofId: digest('source', referenceId),
        origin: consumption.origin,
        sessionId: consumption.sessionId,
        turn: consumption.turn,
        step: consumption.step,
        callId: consumption.callId,
        connectionEpoch,
        botQq,
        targetQq,
      };
      Object.freeze(binding);
      minted.add(binding);
      bindingSources.set(binding, consumption);
      return binding;
    },

    /** True only for a genuine minted binding whose epoch and botQq match the live values. */
    verify(binding, { connectionEpoch, botQq } = {}) {
      return isTrusted(binding) && nonNegative(connectionEpoch) &&
        binding.connectionEpoch === connectionEpoch && binding.botQq === botQq;
    },
  });
}

// Source liveness and object provenance only: this does not verify the current
// connection or account. Call gate.verify() for those checks.
export { isTrusted as isQzoneTrustedBinding };
