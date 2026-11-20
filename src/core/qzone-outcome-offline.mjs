// This boundary accepts canonical status codes from a trusted adapter only.
// It deliberately does not inspect messages, exceptions, or platform payloads.
export const QZONE_OUTCOMES = Object.freeze([
  'success',
  'not_accessible',
  'login_expired',
  'captcha',
  'network_unavailable',
  'failure',
  'unknown',
]);

const CANONICAL_STATUSES = new Set(QZONE_OUTCOMES.filter((outcome) => outcome !== 'unknown'));
const UNKNOWN_RESULT = Object.freeze({ outcome: 'unknown' });

export function classifyQzoneOutcome(normalizedResult) {
  if (normalizedResult === null || typeof normalizedResult !== 'object' || Array.isArray(normalizedResult)) {
    return UNKNOWN_RESULT;
  }

  try {
    const keys = Object.keys(normalizedResult);
    if (keys.length !== 1 || keys[0] !== 'status' || !Object.hasOwn(normalizedResult, 'status')) return UNKNOWN_RESULT;
    const { status } = normalizedResult;
    if (typeof status !== 'string' || !CANONICAL_STATUSES.has(status)) return UNKNOWN_RESULT;
    return Object.freeze({ outcome: status });
  } catch {
    return UNKNOWN_RESULT;
  }
}
