import { randomUUID } from 'node:crypto';
import { claimOfflineNotice, finishOfflineNotice } from './qzone-notice-outbox-offline.mjs';

const RESULTS = new Set(['success', 'failure', 'unknown']);
const ACCESS_FAILURES = new Set(['failure', 'not_accessible', 'login_expired', 'captcha', 'network_unavailable']);

function fixedMessage(notice) {
  if (notice.layer === 'write' && notice.cause === 'failure') {
    return 'QQ空间写入连续失败，写入已暂停。请管理员检查状态并手动处理。';
  }
  if (notice.layer === 'access' && notice.cause === 'probe_failed') {
    return 'QQ空间自动恢复探测失败，需管理员手动检查。';
  }
  if (notice.layer === 'access' && notice.cause === 'probe_interrupted') {
    return 'QQ空间自动恢复探测中断，需管理员手动检查。';
  }
  if (notice.layer === 'access' && ACCESS_FAILURES.has(notice.cause)) {
    return 'QQ空间访问已暂停，需管理员检查状态并手动处理。';
  }
  return null;
}

/**
 * Offline state-machine simulation only. Fixtures are outcomes, never callbacks;
 * this module has no sender, gateway, network, or process-recovery capability.
 */
export function simulateOfflineNoticeDelivery(store, fixtures) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') throw new TypeError('invalid store');
  // Accidental-use guard only, not an authentication or isolation boundary.
  if (store.read().offlineTestFixture !== true) throw new TypeError('fixture required');
  if (!Array.isArray(fixtures)) throw new TypeError('fixtures must be an array');

  for (const fixture of fixtures) {
    if (!fixture || typeof fixture !== 'object' || !Number.isSafeInteger(fixture.index) || fixture.index < 0 || !RESULTS.has(fixture.result)) {
      throw new TypeError('invalid fixture');
    }
  }

  const results = [];
  const processed = new Set();
  for (const fixture of fixtures) {
    if (processed.has(fixture.index)) continue;
    processed.add(fixture.index);
    const notice = store.read().notices?.[fixture.index];
    const message = notice && fixedMessage(notice);
    if (!message) continue;

    const token = randomUUID();
    if (!claimOfflineNotice(store, fixture.index, token).claimed) continue;
    finishOfflineNotice(store, fixture.index, token, fixture.result);
    results.push({
      index: fixture.index,
      status: fixture.result === 'success' ? 'sent' : fixture.result === 'failure' ? 'pending' : 'unknown',
      message,
    });
  }
  return results;
}
