// Offline candidate; snapshot and live authenticity are supplied by caller.
import { createExternalEventExperiment } from './owner-patrol-external-events-prototype.mjs';
export function createSnapshotBoundaryExperiment() {
  const correlation = createExternalEventExperiment();
  let readySession = null; let cursor = null; let generation = 0;
  const invalidate = () => { readySession = null; cursor = null; correlation.disconnect(); };
  const boundary = {
    results: correlation.results,
    snapshot({ sessionId, snapshot }) {
      invalidate();
      if (typeof sessionId !== 'string' || !sessionId || snapshot?.type !== 'snapshot' || !Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < -1) return false;
      readySession = sessionId; cursor = snapshot.cursor; return true;
    },
    begin({ sessionId, requestId, ownerPending }) {
      if (readySession !== sessionId || ownerPending !== false) return false;
      return correlation.begin({ sessionId, requestId });
    },
    live({ sessionId, event }) {
      if (readySession !== sessionId) return;
      if (!Number.isSafeInteger(event?.seq) || event.seq !== cursor + 1) { invalidate(); return; }
      cursor = event.seq;
      correlation.accept({ sessionId, event });
    },
    ownerReceived({ sessionId }) { correlation.ownerReceived({ sessionId }); },
    followEnded({ sessionId }) { if (readySession === sessionId) invalidate(); },
    openFollow({ sessionId }) {
      invalidate();
      const own = ++generation;
      return {
        snapshot: snapshot => own === generation && boundary.snapshot({ sessionId, snapshot }),
        live: event => { if (own === generation) boundary.live({ sessionId, event }); },
        end: () => { if (own === generation) { invalidate(); generation += 1; } },
      };
    },
  };
  return boundary;
}
