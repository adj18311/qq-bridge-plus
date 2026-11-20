const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

// Only call from a DSH native tool handler: callers must still authenticate
// this context when sending it to another process. No model argument is used.
export function getQzoneDshSessionContext(exec) {
  try {
    const sessionId = exec?.agent?.session?.id;
    const callId = exec?.callId;
    if (typeof sessionId !== 'string' || !ID.test(sessionId) ||
        typeof callId !== 'string' || !ID.test(callId)) return null;
    return Object.freeze({ sessionId, callId });
  } catch {
    return null;
  }
}
