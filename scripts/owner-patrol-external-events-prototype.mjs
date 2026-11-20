// Offline external event correlation experiment, not a production bridge.
export function createExternalEventExperiment() {
  let task = null;
  const results = [];
  return {
    results,
    begin({ sessionId, requestId }) {
      if (task || typeof sessionId !== 'string' || !sessionId || typeof requestId !== 'string' || !requestId) return false;
      task = { sessionId, requestId, lastSeq: null, turn: null, found: false, other: false };
      return true;
    },
    ownerReceived({ sessionId }) { if (task && task.sessionId === sessionId) task.other = true; },
    disconnect() { task = null; },
    followEnded({ sessionId }) { if (task && task.sessionId === sessionId) task = null; },
    accept({ sessionId, event }) {
      if (!task || sessionId !== task.sessionId) return;
      if (!Number.isSafeInteger(event?.seq) || (task.lastSeq !== null && event.seq !== task.lastSeq + 1)) { task = null; return; }
      task.lastSeq = event.seq;
      if (event.type === 'turn/start') {
        if (task.turn !== null || !Number.isSafeInteger(event.data?.turn)) { task = null; return; }
        task.turn = event.data.turn;
      } else if (event.type === 'user/message' && task.turn !== null) {
        if (event.data?.source?.kind === 'user' && event.data.source.rpcId === task.requestId) task.found = true;
        else task.other = true;
      } else if (event.type === 'turn/end' && task.turn !== null && event.data?.turn === task.turn) {
        if (!task.found) { task.turn = null; return; }
        if (task.found && event.data?.reason?.kind === 'completed') results.push({ turn: task.turn, share: !task.other });
        task = null;
      }
    },
  };
}
