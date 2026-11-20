// Offline-only experiment. Task lifecycle must come from trusted bridge/host hooks.
export function createOfflinePatrolSendGate() {
  let active = null;
  let revision = 0;
  return {
    begin({ sessionId, turn }) {
      if (active || typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(turn)) return false;
      active = { sessionId, turn, ownerPending: false }; return true;
    },
    ownerArrived({ sessionId }) { if (active?.sessionId === sessionId) active.ownerPending = true; },
    interrupt({ sessionId }) { if (active?.sessionId === sessionId) { active.uncertain = true; revision += 1; } },
    observeTurnStart({ sessionId }) { if (active?.sessionId === sessionId) revision += 1; },
    async probeStopped({ sessionId, turn, query }) {
      if (!active || !active.uncertain || active.sessionId !== sessionId || active.turn !== turn || typeof query !== 'function') return false;
      const original = active; const before = revision;
      let result;
      try { result = await query(); } catch { return false; }
      if (active !== original || revision !== before || result?.sessionId !== sessionId || result.running !== false) return false;
      active = null; return true;
    },
    claimSend({ sessionId, turn }) {
      if (!active || active.sessionId !== sessionId) return { kind: 'not-patrol' };
      if (active.uncertain || active.turn !== turn) return { kind: 'unknown', allow: false };
      return { kind: 'patrol', allow: !active.ownerPending };
    },
    finish({ sessionId, turn }) {
      if (!active || active.uncertain || active.sessionId !== sessionId || active.turn !== turn) return false;
      active = null; return true;
    },
    confirmStopped({ sessionId, turn, stopped }) {
      if (!active || !active.uncertain || active.sessionId !== sessionId || active.turn !== turn || stopped !== true) return false;
      active = null; return true;
    },
  };
}
