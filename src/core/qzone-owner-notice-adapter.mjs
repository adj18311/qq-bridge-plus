import { isValidDeliveredMessageId } from './owner-notice-bridge-wiring.mjs';

// sendOwnerReceipt is supplied privately by the bridge, which binds the
// recipient to its configured owner. Non-delivery is never inferred from its
// generic "failed" result: a packet may already have reached the platform.
export function createQzoneOwnerNoticeSender(sendOwnerReceipt) {
  if (typeof sendOwnerReceipt !== 'function') throw new TypeError('invalid owner sender');
  return async function sendQzoneOwnerNotice(message, { signal } = {}) {
    if (typeof message !== 'string' || !message || signal?.aborted) return 'unknown';
    try {
      const result = await sendOwnerReceipt(message);
      return result?.outcome === 'delivered' && isValidDeliveredMessageId(result.messageId) ? 'success' : 'unknown';
    } catch { return 'unknown'; }
  };
}
