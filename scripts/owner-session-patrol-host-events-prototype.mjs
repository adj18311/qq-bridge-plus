// Offline fixture adapter, not a production trust boundary.
export function createOfflineHostEventCoordinator() {
  let active = null;
  let streamGeneration = 0;
  const decisions = [];
  const coordinator = {
    decisions,
    begin({ sessionId, messageId }) {
      if (active || !sessionId || !messageId) return false;
      active = { sessionId, messageId, turn: null, ownerMessages: [] };
      return true;
    },
    hostStep({ sessionId, turn, messages }) {
      if (!active || active.sessionId !== sessionId || active.turn !== null) return;
      if (Number.isSafeInteger(turn) && Array.isArray(messages) && messages.some(m => m.id === active.messageId)) active.turn = turn;
    },
    ownerMessage({ sessionId, messageId }) {
      if (active && active.sessionId === sessionId && typeof messageId === 'string' && messageId) active.ownerMessages.push(messageId);
    },
    receiveOwner({ sessionId, messageId, receive }) {
      // Fixture assumes the caller already authenticated the owner and session.
      this.ownerMessage({ sessionId, messageId });
      return receive();
    },
    disconnect() { active = null; streamGeneration += 1; },
    createStream() {
      if (active) throw new Error('active patrol must be invalidated before replacing stream');
      const generation = ++streamGeneration;
      return {
        hostStep: value => { if (generation === streamGeneration) coordinator.hostStep(value); },
        hostEvent: value => { if (generation === streamGeneration) coordinator.hostEvent(value); },
      };
    },
    hostEvent({ sessionId, event }) {
      if (!active || active.sessionId !== sessionId || active.turn === null || event?.type !== 'turn/end' || event.data?.turn !== active.turn) return;
      if (event.data?.reason?.kind !== 'completed') { active = null; return; }
      const ownerMessages = active.ownerMessages.slice();
      decisions.push({ share: ownerMessages.length === 0, ownerMessages, turn: active.turn });
      active = null;
    },
  };
  return coordinator;
}
