import { authorizeTool } from './qzone-policy-offline.mjs';
import { reserveAuditedOfflineRead } from './qzone-read-reservation-offline.mjs';
import { settleAuditedOfflineRead } from './qzone-settlement-offline.mjs';
import { filterOfflineComments } from './qzone-comment-filter-offline.mjs';
import { allowOfflineComments } from './qzone-read-boundary-offline.mjs';
import { filterOfflineOwnNewComment } from './qzone-own-comment-offline.mjs';

const validId = (value) => typeof value === 'string' && value.trim().length > 0;
const validAuditId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const validAuthorId = (value) => typeof value === 'string' && /^\d{1,20}$/.test(value);
const OUTCOMES = new Set(['success', 'failure', 'unknown', 'not_accessible', 'login_expired', 'captcha', 'network_unavailable']);
const MAX_PAGE_COMMENTS = 100;
const REASONS = Object.freeze({ failure: 'other', not_accessible: 'not_accessible', login_expired: 'login_expired',
  captcha: 'captcha', network_unavailable: 'network' });

function snapshotRecord(value, fields) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const snapshot = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (descriptor && !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[field] = descriptor ? descriptor.value : undefined;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

// Snapshot the fake response before any projection. Accessors are rejected,
// and only the captured data fields are passed to the existing filters.
function snapshotPage(page) {
  if (!page || !Array.isArray(page.comments)) return null;
  const list = page.comments;
  const length = Object.getOwnPropertyDescriptor(list, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) ||
      length.value < 0 || length.value > MAX_PAGE_COMMENTS) return null;
  const comments = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
    if (!descriptor) continue;
    if (!Object.hasOwn(descriptor, 'value')) return null;
    const entry = descriptor.value;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      comments.push(null);
      continue;
    }
    const comment = snapshotRecord(entry, ['id', 'author', 'time', 'content']);
    if (!comment) return null;
    comments.push(comment);
  }
  return { author: page.author, postId: page.postId, comments };
}

function snapshotResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(response))) return { outcome: 'unknown', page: null };
  // A trusted, explicit failure takes precedence even if the response also
  // contains comments, which must not be inspected or returned in that case.
  const outcome = Object.getOwnPropertyDescriptor(response, 'outcome');
  if (outcome && (!Object.hasOwn(outcome, 'value') || !OUTCOMES.has(outcome.value))) {
    return { outcome: 'unknown', page: null };
  }
  if (outcome && outcome.value !== 'success') return { outcome: outcome.value, page: null };

  const root = snapshotRecord(response, ['page', 'author', 'postId', 'comments']);
  if (!root) return { outcome: 'unknown', page: null };
  if (Array.isArray(root.comments)) {
    if (root.page !== undefined) return { outcome: 'unknown', page: null };
    const page = snapshotPage(root);
    return { outcome: page ? 'success' : 'unknown', page };
  }
  if (!outcome || root.comments !== undefined || root.author !== undefined || root.postId !== undefined) {
    return { outcome: 'unknown', page: null };
  }
  const pageRecord = snapshotRecord(root.page, ['author', 'postId', 'comments', 'outcome', 'page']);
  if (!pageRecord || pageRecord.outcome !== undefined || pageRecord.page !== undefined) {
    return { outcome: 'unknown', page: null };
  }
  const page = snapshotPage(pageRecord);
  return { outcome: page ? 'success' : 'unknown', page };
}

function snapshotInputs(request, target, metadata, scope) {
  const requestSnapshot = snapshotRecord(request,
    ['id', 'now', 'tool', 'source', 'target', 'postId', 'commentId', 'activeTime', 'opportunity']);
  const targetSnapshot = snapshotRecord(target, ['author', 'id']);
  const metadataSnapshot = snapshotRecord(metadata, ['author', 'id', 'time']);
  // `admin` is deliberately NOT in this list any more (t47): the privilege it stood for was
  // cancelled, and `snapshotRecord` ignores fields it is not told about, so a caller that still
  // passes `admin: true` simply gets no authorization from it instead of an error.
  const scopeSnapshot = snapshotRecord(scope,
    ['author', 'now', 'friend', 'sharedPostId', 'selfId', 'isNew', 'postId', 'commentId',
      'eventPostId', 'eventCommentId', 'event']);
  if (!requestSnapshot || !targetSnapshot || !metadataSnapshot || !scopeSnapshot) return null;

  let event = null;
  if (scopeSnapshot.event !== undefined && scopeSnapshot.event !== null) {
    event = snapshotRecord(scopeSnapshot.event, ['isNew', 'selfId', 'author', 'postId', 'commentId']);
    if (!event) return null;
  } else {
    event = ownCommentEventFromScope(scopeSnapshot);
  }
  return { request: requestSnapshot, target: targetSnapshot, metadata: metadataSnapshot,
    scope: scopeSnapshot, event };
}

function ownCommentEventFromScope(scope) {
  if (!scope || typeof scope !== 'object') return null;
  if (scope.event && typeof scope.event === 'object') return scope.event;
  if (scope.isNew === true ||
      (validId(scope.eventPostId) && validId(scope.eventCommentId))) return scope;
  return null;
}

function trustedInputsMatch(request, target, metadata, scope, event) {
  const common = !!request && !!target && !!metadata && !!scope &&
    request.tool === 'read_comments' &&
    validAuthorId(request.target) && validAuditId(request.id) && validAuditId(request.postId) &&
    validAuthorId(target.author) && validAuditId(target.id) &&
    target.author === request.target && target.id === request.postId &&
    validId(metadata.author) && validId(metadata.id) && Number.isFinite(metadata.time) &&
    metadata.author === target.author && metadata.id === target.id &&
    validId(scope.author) && scope.author === target.author && scope.now === request.now;
  if (!common) return false;
  if (event) {
    return event.isNew === true && validAuthorId(event.selfId) && event.selfId === target.author &&
      validAuthorId(event.author) && event.author === target.author &&
      validAuditId(event.postId) && event.postId === target.id &&
      validAuditId(event.commentId) && request.commentId === event.commentId;
  }
  return request.commentId == null &&
    (scope.friend === true || scope.sharedPostId === target.id);
}

// Offline simulation only. The trusted caller must authenticate the QQ event
// and construct target, metadata and scope from verified facts; model-provided
// assertions are not authorization evidence. `fake` must be an injected fake,
// never a network transport. Only the exact authorized post is passed to it.
export async function simulateOfflineComments(store, request, target, metadata, scope, fake) {
  if (typeof fake !== 'function') throw new TypeError('fake transport required');
  const captured = snapshotInputs(request, target, metadata, scope);
  if (!captured) return { allowed: false, outcome: 'unknown', comments: [] };
  const safeRequest = captured.request;
  const safeTarget = captured.target;
  const safeMetadata = captured.metadata;
  const safeScope = captured.scope;
  const event = captured.event;
  if (!store || typeof store.read !== 'function' ||
      !trustedInputsMatch(safeRequest, safeTarget, safeMetadata, safeScope, event) ||
      !Number.isFinite(safeRequest.now) || !['requested', 'proactive'].includes(safeRequest.source) ||
      (safeRequest.source === 'proactive' && !validId(safeRequest.opportunity)) ||
      (!event && !allowOfflineComments(safeTarget, safeMetadata, safeScope))) {
    return { allowed: false, outcome: 'unknown', comments: [] };
  }

  const input = { time: safeRequest.now, source: safeRequest.source === 'proactive' ? 'patrol' : 'qq',
    action: 'read_comments', target: safeRequest.target, postId: safeRequest.postId,
    commentId: safeRequest.commentId ?? null, content: '', result: 'unknown', reason: '' };
  const reservation = reserveAuditedOfflineRead(store, safeRequest, input);
  if (!reservation.allowed) return { allowed: false, reason: reservation.reason, comments: [] };

  // Explicit before-dispatch gate: permission may have changed after reserve.
  const gate = authorizeTool(store.read(), 'read_comments');
  if (!gate.allowed) {
    settleAuditedOfflineRead(store, safeRequest.id, 'unknown', input, safeRequest.now);
    return { allowed: false, reason: gate.reason, outcome: 'unknown', reserved: true };
  }

  let response;
  try {
    response = await fake(event
      ? Object.freeze({ author: safeTarget.author, id: safeTarget.id, commentId: event.commentId })
      : Object.freeze({ author: safeTarget.author, id: safeTarget.id }));
  }
  catch { response = null; }

  let outcome = 'unknown';
  let comments = [];
  try {
    const parsed = snapshotResponse(response);
    outcome = parsed.outcome;
    const page = parsed.page;
    if (outcome === 'success') {
      if (event) {
        const comment = filterOfflineOwnNewComment(event, {
          author: safeTarget.author, postId: safeTarget.id, commentId: event.commentId,
        }, page);
        if (comment) comments = [comment];
        else outcome = 'unknown';
      } else if (page.author !== safeTarget.author || page.postId !== safeTarget.id) {
        outcome = 'unknown';
      } else {
        comments = filterOfflineComments(safeTarget, safeMetadata, safeScope, page);
      }
    }
  } catch {
    outcome = 'unknown';
    comments = [];
  }
  const result = outcome === 'success' ? 'success' : outcome === 'unknown' ? 'unknown' : 'failure';
  settleAuditedOfflineRead(store, safeRequest.id, outcome, { ...input, result, reason: REASONS[outcome] ?? '' }, safeRequest.now);
  return { allowed: true, outcome, comments };
}
