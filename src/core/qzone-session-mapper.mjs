const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const QQ_KEY = /^(private|group):([1-9][0-9]*)$/u;
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

const deny = (reason) => Object.freeze({ ok: false, reason });

/**
 * Resolve a DSH native session context against an offline snapshot of bridge state.
 * The observation time bounds how old the supplied snapshot/context may be; it is
 * deliberately required because bridge sessions.json has no per-mapping freshness.
 * This function cannot establish where either input came from: a caller must bind
 * the context to a native DSH execution and read the current mapping itself.
 * `observedAt` is not proof that the snapshot was fresh or authenticated.
 * A resolved private/group key is a destination, not proof of the current
 * requester, message origin, administrator authority, or patrol opportunity.
 */
export function mapQzoneDshSession({ bridgeState, dshContext, nowMs, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  try {
    const sessionId = dshContext?.agent?.session?.id;
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return deny('missing-session-context');

    const observedAt = dshContext?.observedAt;
    if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(observedAt) ||
        !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 ||
        observedAt > nowMs || nowMs - observedAt > maxAgeMs) return deny('stale-or-invalid-observation');

    const sessions = bridgeState?.sessions;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return deny('missing-session-map');
    const matches = Object.entries(sessions).filter(([, value]) => value === sessionId);
    if (matches.length === 0) return deny('session-unmapped');
    if (matches.length !== 1) return deny('ambiguous-session');

    const [key] = matches[0];
    const parsed = QQ_KEY.exec(key);
    if (!parsed || !Number.isSafeInteger(Number(parsed[2]))) return deny('invalid-session-key');
    return Object.freeze({
      ok: true,
      key,
      kind: parsed[1],
      qqId: parsed[2],
      sessionId,
    });
  } catch {
    return deny('invalid-input');
  }
}
