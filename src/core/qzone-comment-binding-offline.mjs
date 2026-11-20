import { allowOfflineComments } from './qzone-read-boundary-offline.mjs';
import { canReadNewOwnComment } from './qzone-policy-offline.mjs';

const ERROR = 'invalid authorized qzone reply binding';
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function invalid() { throw new TypeError(ERROR); }

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value;
}

function field(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
  return descriptor.value;
}

function optionalField(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) invalid();
  return descriptor.value;
}

function text(value, pattern = null) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 1024 * 1024 || (pattern && !pattern.test(value))) invalid();
  return value;
}

function qq(value) {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || String(number) !== value) invalid();
    return String(number);
  }
  if (!Number.isSafeInteger(value) || value <= 0) invalid();
  return String(value);
}

function list(value, max = 100) {
  if (!Array.isArray(value) || value.length > max) invalid();
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    result.push(descriptor.value);
  }
  return result;
}

function snapshotAuthorization(targetInput, metadataInput, scopeInput) {
  const sourceTarget = record(targetInput);
  const sourceMetadata = record(metadataInput);
  const sourceScope = record(scopeInput);
  const target = { author: qq(field(sourceTarget, 'author')), id: text(field(sourceTarget, 'id'), ID) };
  const metadata = {
    author: qq(field(sourceMetadata, 'author')),
    id: text(field(sourceMetadata, 'id'), ID),
    time: field(sourceMetadata, 'time'),
  };
  // ⚠️ `admin` IS NO LONGER READ (t47). A scope that still carries `admin: true` is accepted but
  // buys nothing: `allowOfflineComments` -> `canReadPost` no longer honours it, so only `friend`
  // (with the seven-day window) and `sharedPostId` (one explicitly shared post) can authorize.
  // Capturing the field and then ignoring it would be worse than not capturing it: a caller would
  // see it validated and assume it still meant something.
  const scope = {
    author: qq(field(sourceScope, 'author')),
    friend: field(sourceScope, 'friend'),
    sharedPostId: optionalField(sourceScope, 'sharedPostId'),
    now: field(sourceScope, 'now'),
  };
  if (typeof scope.friend !== 'boolean' ||
      (scope.sharedPostId !== undefined && typeof scope.sharedPostId !== 'string') ||
      !Number.isFinite(scope.now) || !Number.isFinite(metadata.time) ||
      !allowOfflineComments(target, metadata, scope)) invalid();
  return { target, metadata, scope };
}

function bind(target, detail, parentIdInput, replyIdInput) {
  const parentId = text(parentIdInput, ID);
  const replyId = text(replyIdInput, ID);
  const envelope = record(detail);
  if (field(envelope, 'status') !== 'ok' || field(envelope, 'retcode') !== 0) invalid();
  const data = record(field(envelope, 'data'));
  const postId = text(field(data, 'tid'), ID);
  if (postId !== target.id) invalid();

  const comments = list(field(data, 'comments'));
  const parents = [];
  for (const rawParent of comments) {
    const parent = record(rawParent);
    if (field(parent, 'comment_id') === parentId) parents.push(parent);
  }
  if (parents.length !== 1) invalid();

  const parent = parents[0];
  const parentCommentId = text(field(parent, 'comment_id'), ID);
  const parentQq = qq(field(parent, 'uin'));
  text(field(parent, 'name'));
  const replies = list(field(parent, 'replies'));
  const matches = [];
  for (const rawReply of replies) {
    const reply = record(rawReply);
    if (field(reply, 'comment_id') === replyId) matches.push(reply);
  }
  if (matches.length !== 1) invalid();

  const reply = matches[0];
  const replyCommentId = text(field(reply, 'comment_id'), ID);
  const replyQq = qq(field(reply, 'uin'));
  const replyName = text(field(reply, 'name'));
  if (text(field(reply, 'parent_comment_id'), ID) !== parentCommentId ||
      qq(field(reply, 'parent_comment_uin')) !== parentQq) invalid();

  return Object.freeze({
    targetQq: target.author,
    postId,
    parentCommentId,
    parentQq,
    replyCommentId,
    replyQq,
    replyName,
  });
}

function snapshotOwnNewEvent(targetInput, eventInput, selectedCommentIdInput) {
  const sourceTarget = record(targetInput);
  const sourceEvent = record(eventInput);
  const target = {
    author: qq(field(sourceTarget, 'author')),
    id: text(field(sourceTarget, 'id'), ID),
  };
  const selectedCommentId = text(selectedCommentIdInput, ID);
  const event = {
    isNew: field(sourceEvent, 'isNew'),
    selfId: qq(field(sourceEvent, 'selfId')),
    author: qq(field(sourceEvent, 'author')),
    postId: text(field(sourceEvent, 'postId'), ID),
    commentId: text(field(sourceEvent, 'commentId'), ID),
  };
  if (!canReadNewOwnComment(event, {
    author: target.author,
    postId: target.id,
    commentId: selectedCommentId,
  })) invalid();
  return { target, event, selectedCommentId };
}

function detailData(target, detail) {
  const envelope = record(detail);
  if (field(envelope, 'status') !== 'ok' || field(envelope, 'retcode') !== 0) invalid();
  const data = record(field(envelope, 'data'));
  if (text(field(data, 'tid'), ID) !== target.id) invalid();
  return data;
}

function validateUniqueEventCommentPage(data) {
  if (typeof field(data, 'content') !== 'string') invalid();
  const commentCount = field(data, 'comment_num');
  if (!Number.isSafeInteger(commentCount) || commentCount < 0) invalid();
  const comments = list(field(data, 'comments'));
  const ids = new Set();
  let total = 0;
  const register = (id) => {
    if (ids.has(id)) invalid();
    ids.add(id);
    total += 1;
    if (total > 100) invalid();
  };
  const validateFields = (comment) => {
    const id = text(field(comment, 'comment_id'), ID);
    const uin = qq(field(comment, 'uin'));
    if (typeof field(comment, 'name') !== 'string' ||
        !Number.isSafeInteger(field(comment, 'time')) || field(comment, 'time') < 0 ||
        typeof field(comment, 'content') !== 'string') invalid();
    return { id, uin };
  };

  for (const rawParent of comments) {
    const parent = record(rawParent);
    const parentIdentity = validateFields(parent);
    register(parentIdentity.id);
    const replies = list(field(parent, 'replies'));
    for (const rawReply of replies) {
      const reply = record(rawReply);
      const replyIdentity = validateFields(reply);
      register(replyIdentity.id);
      if (text(field(reply, 'parent_comment_id'), ID) !== parentIdentity.id ||
          qq(field(reply, 'parent_comment_uin')) !== parentIdentity.uin) invalid();
    }
  }
}

// Binds one already-authorized reply from a SnowLuma detail response. The
// caller must supply trusted target, post metadata and scope; this pure helper
// cannot authorize a fetch or prove where those context values came from.
// It returns identity fields for the selected reply only, never page content.
export function bindAuthorizedQzoneReply(target, metadata, scope, detail, parentCommentId, replyCommentId) {
  try {
    const authorization = snapshotAuthorization(target, metadata, scope);
    return bind(authorization.target, detail, parentCommentId, replyCommentId);
  } catch {
    throw new TypeError(ERROR);
  }
}

// Exception for a trusted, authenticated new-comment event on the bot's own
// older post. The event is the authorization evidence and must be verified by
// the caller as platform-originated. This identity binding does not authorize
// a write or permit returning/logging other comments from the detail page.
export function bindAuthorizedOwnNewQzoneComment(target, event, detail, commentId) {
  try {
    const authorization = snapshotOwnNewEvent(target, event, commentId);
    const data = detailData(authorization.target, detail);
    validateUniqueEventCommentPage(data);
    const comments = list(field(data, 'comments'));
    const matches = [];
    for (const rawComment of comments) {
      const comment = record(rawComment);
      if (field(comment, 'comment_id') === authorization.selectedCommentId) matches.push(comment);
    }
    if (matches.length !== 1) invalid();
    const comment = matches[0];
    return Object.freeze({
      targetQq: authorization.target.author,
      postId: authorization.target.id,
      commentId: text(field(comment, 'comment_id'), ID),
      commentQq: qq(field(comment, 'uin')),
      commentName: text(field(comment, 'name')),
    });
  } catch {
    throw new TypeError(ERROR);
  }
}

// Same trusted event prerequisite for a new second-level reply on the bot's
// own older post. The event comment ID must equal the selected reply ID; the
// reply must also match the selected parent in the detail payload. This is not
// a write authorization and returns no page or unrelated comment data.
export function bindAuthorizedOwnNewQzoneReply(target, event, detail, parentCommentId, replyCommentId) {
  try {
    const authorization = snapshotOwnNewEvent(target, event, replyCommentId);
    validateUniqueEventCommentPage(detailData(authorization.target, detail));
    return bind(authorization.target, detail, parentCommentId, authorization.selectedCommentId);
  } catch {
    throw new TypeError(ERROR);
  }
}
