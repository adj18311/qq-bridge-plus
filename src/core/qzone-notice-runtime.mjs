import { claimOfflineNotice, finishOfflineNotice } from './qzone-notice-outbox-offline.mjs';

const OUTCOMES = new Set(['success', 'failure', 'unknown']);
const DEFAULT_TIMEOUT_MS = 15_000;

function fixedMessage(notice) {
  if (notice?.layer === 'write' && notice.cause === 'failure') {
    return 'QQ空间写入连续失败，写入已暂停。请管理员检查状态并手动处理。';
  }
  if (notice?.layer === 'access' && notice.cause === 'probe_failed') {
    return 'QQ空间自动恢复探测失败，需管理员手动检查。';
  }
  if (notice?.layer === 'access' && notice.cause === 'probe_interrupted') {
    return 'QQ空间自动恢复探测中断，需管理员手动检查。';
  }
  if (notice?.layer === 'access' && ['failure', 'not_accessible', 'login_expired', 'captcha', 'network_unavailable'].includes(notice.cause)) {
    return 'QQ空间访问已暂停，需管理员检查状态并手动处理。';
  }
  return null;
}

async function awaitSenderOrAbort(senderResult, signal) {
  if (!signal) return senderResult;
  if (signal.aborted) return 'unknown';
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve('unknown');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([senderResult, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Dispatch one allowlisted administrator notice through an injected sender.
 * A sender exception, invalid response, or cancellation is conservatively unknown.
 * A failure result is safe to retry only if the sender proves nothing was sent.
 * Cross-process safety requires a shared synchronous transactional store.
 * A Boolean cannot prove that an earlier process or sender has stopped.
 */
export async function dispatchNotice(store, index, options) {
  let signalValid = true;
  if (options?.signal !== undefined) {
    try {
      signalValid = typeof options.signal?.addEventListener === 'function' &&
        typeof options.signal?.removeEventListener === 'function' &&
        typeof options.signal?.aborted === 'boolean';
    } catch {
      signalValid = false;
    }
  }
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function' ||
      !options || typeof options !== 'object' || typeof options.token !== 'string' ||
      typeof options.sender !== 'function' ||
      !signalValid ||
      (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000)) ||
      Object.hasOwn(options, 'exclusiveOwnershipConfirmed')) throw new TypeError('invalid options');

  let notice;
  try { notice = store.read().notices?.[index]; } catch { return { status: 'unknown' }; }
  const message = fixedMessage(notice);
  if (!message) return { status: 'unsupported' };

  let claim;
  try { claim = claimOfflineNotice(store, index, options.token); }
  catch { return { status: 'unknown' }; } // The claim may already have committed.
  if (!claim.claimed) return { status: 'not_claimed' };

  // The outbox claim may observe a different notice than the advisory read above.
  // Dispatch only from the record that now carries this claim token.
  let claimedNotice;
  try { claimedNotice = store.read().notices?.[index]; }
  catch {
    try { finishOfflineNotice(store, index, options.token, 'unknown'); } catch {}
    return { status: 'unknown' };
  }
  const claimedMessage = claimedNotice?.delivery === 'claimed' && claimedNotice.claimToken === options.token
    ? fixedMessage(claimedNotice)
    : null;
  if (!claimedMessage) {
    try { finishOfflineNotice(store, index, options.token, 'unknown'); } catch {}
    return { status: 'unsupported' };
  }

  let outcome = 'unknown';
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer;
  const forwardAbort = () => controller.abort();
  try {
    if (options.signal?.aborted) {
      outcome = 'unknown';
    } else {
      options.signal?.addEventListener('abort', forwardAbort, { once: true });
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const senderResult = Promise.resolve().then(() => {
        // Abort can happen after dispatchNotice returns but before this microtask runs.
        if (options.signal?.aborted || controller.signal.aborted) return 'unknown';
        return options.sender(claimedMessage, { signal: controller.signal });
      });
      // Convert rejection to a value before racing so a late rejection after abort is handled.
      const settledSender = senderResult.then(
        (value) => OUTCOMES.has(value) ? value : 'unknown',
        () => 'unknown',
      );
      outcome = await awaitSenderOrAbort(settledSender, controller.signal);
    }
  } catch {
    outcome = 'unknown';
  } finally {
    clearTimeout(timer);
    try { options.signal?.removeEventListener('abort', forwardAbort); } catch {}
  }

  try {
    finishOfflineNotice(store, index, options.token, outcome);
  } catch {
    return { status: 'unknown' };
  }
  return { status: outcome === 'success' ? 'sent' : outcome };
}
