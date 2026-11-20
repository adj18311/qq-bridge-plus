import { reserveAuditedOfflinePost, reserveAuditedOfflineInteraction } from './qzone-reservation-offline.mjs';
import { settleAuditedOfflineWrite, settleAuditedOfflineRead } from './qzone-settlement-offline.mjs';
import { authorizeTool, filterOfflinePosts } from './qzone-policy-offline.mjs';
import { formatAuditRecord } from './qzone-audit-offline.mjs';
import { reserveAuditedOfflineRead } from './qzone-read-reservation-offline.mjs';

// A test harness, not a network adapter. The provided fake must never be a
// real platform transport. Unknown/throwing outcomes are not replayed.
export async function simulateOfflinePost(store, request, fake) {
  if (typeof fake !== 'function') throw new TypeError('fake transport required');
  request = { ...request };
  const input = { ...request.audit, time: request.now, action: 'publish', result: 'unknown', reason: '' };
  formatAuditRecord(input);
  const reservation = reserveAuditedOfflinePost(store, request, input);
  if (!reservation.allowed) return reservation;
  // This narrows but cannot eliminate a cross-process check/dispatch race.
  const gate = authorizeTool(store.read(), 'publish');
  if (!gate.allowed) return { allowed: false, reason: gate.reason, reserved: true };
  let outcome;
  try { outcome = await fake(); } catch { outcome = 'unknown'; }
  if (!['success', 'failure', 'unknown', 'not_accessible', 'login_expired', 'captcha', 'network_unavailable'].includes(outcome)) outcome = 'unknown';
  const result = outcome === 'success' ? 'success' : outcome === 'unknown' ? 'unknown' : 'failure';
  const reason = ['not_accessible', 'login_expired', 'captcha', 'network_unavailable'].includes(outcome)
    ? (outcome === 'network_unavailable' ? 'network' : outcome) : outcome === 'failure' ? 'other' : '';
  settleAuditedOfflineWrite(store, request.id, outcome, { ...input, result, reason }, request.now);
  return { allowed: true, outcome };
}

// Test-only harness; never supply a real network transport.
export async function simulateOfflineInteraction(store, request, fake) {
  if (typeof fake !== 'function' || !request) throw new TypeError('fake transport required');
  request = { ...request };
  const input = { time: request.now, source: request.source, action: request.tool, target: request.target,
    postId: request.postId, commentId: request.commentId, content: request.audit?.content, result: 'unknown', reason: '' };
  formatAuditRecord(input);
  const reservation = reserveAuditedOfflineInteraction(store, request, input);
  if (!reservation.allowed) return reservation;
  // This narrows but cannot eliminate a cross-process check/dispatch race.
  const gate = authorizeTool(store.read(), request.tool);
  if (!gate.allowed) return { allowed: false, reason: gate.reason, reserved: true };
  let outcome;
  try { outcome = await fake(); } catch { outcome = 'unknown'; }
  if (!['success', 'failure', 'unknown', 'not_accessible', 'login_expired', 'captcha', 'network_unavailable'].includes(outcome)) outcome = 'unknown';
  const result = outcome === 'success' ? 'success' : outcome === 'unknown' ? 'unknown' : 'failure';
  const reason = ['not_accessible', 'login_expired', 'captcha', 'network_unavailable'].includes(outcome)
    ? (outcome === 'network_unavailable' ? 'network' : outcome) : outcome === 'failure' ? 'other' : '';
  settleAuditedOfflineWrite(store, request.id, outcome, { ...input, result, reason }, request.now);
  return { allowed: true, outcome };
}

// Test-only: `scope` must be trusted. Filtering a returned page does not prove
// an upstream service avoided obtaining other content; never use a real transport.
export async function simulateOfflineFriendRead(store, request, scope, fake) {
  if (typeof fake !== 'function' || !request || !scope) throw new TypeError('trusted friend scope required');
  request = { ...request };
  scope = { ...scope };
  if (scope.friend !== true || scope.author !== request.target || request.tool !== 'read_posts') throw new TypeError('trusted friend scope required');
  const input = { time: request.now, source: request.source === 'proactive' ? 'patrol' : 'qq', action: 'read_posts',
    target: request.target, content: '', result: 'unknown', reason: '' };
  const reservation = reserveAuditedOfflineRead(store, request, input);
  if (!reservation.allowed) return reservation;
  const gate = authorizeTool(store.read(), 'read_posts');
  if (!gate.allowed) return { allowed: false, reason: gate.reason, reserved: true };
  let response;
  try { response = await fake(); } catch { response = null; }
  const reasons = { failure: 'other', not_accessible: 'not_accessible', login_expired: 'login_expired', captcha: 'captcha', network_unavailable: 'network' };
  // The fake's classification is trusted only in this offline harness; a real
  // adapter must classify platform evidence independently of model input.
  let outcome = 'unknown';
  let filtered = [];
  try {
    outcome = Array.isArray(response) ? 'success' :
      response && typeof response.outcome === 'string' && Object.hasOwn(reasons, response.outcome) ? response.outcome : 'unknown';
    if (outcome === 'success') filtered = filterOfflinePosts(response, { author: request.target, friend: true, now: request.now });
  } catch {
    outcome = 'unknown';
    filtered = [];
  }
  const result = outcome === 'success' ? 'success' : outcome === 'unknown' ? 'unknown' : 'failure';
  settleAuditedOfflineRead(store, request.id, outcome, { ...input, result, reason: reasons[outcome] ?? '' }, request.now);
  return { allowed: true, outcome, posts: filtered };
}
