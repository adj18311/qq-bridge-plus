// Reading the comments of ANY post — the offline filter for the `plain-comments` scope.
//
// WHY THIS IS A SEPARATE MODULE FROM `qzone-comment-filter-offline.mjs`
// ----------------------------------------------------------------
// That one answers "may I see the comments of THIS post?" and returns `[]` when the answer is
// no — a shape that suits a caller which asked a question and must get an answer either way.
// This one filters a PAGE that has already been authorised: the scope kind (`plain-comments`) is
// the authorisation, and the page's identity is checked here rather than re-derived from post
// metadata the platform never sent (measured: `get_qzone_msg_detail` does NOT return the post's
// own `time`, so "is the post within seven days" is unanswerable from a detail response).
//
// WHAT THE SEVEN-DAY WINDOW MEANS HERE: the COMMENT's own time, not the post's.
//   A comment written yesterday on a two-year-old post IS visible; that is the only reading this
//   layer can support, because the post's age is not in the response. Filtering on the comment's
//   own timestamp is also the honest direction: it shows what was said recently, which is what a
//   reader looking at a comment page is actually asking about.

/** The comment fields the caller receives — identical to the own-comment filter's shape. */
const COMMENT_FIELDS = Object.freeze(['id', 'author', 'time', 'content']);
const SEVEN_DAYS_MS = 7 * 86400000;

function invalid() {
  throw new TypeError('invalid comment page');
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Read one own DATA property; an accessor throws rather than being executed. */
function ownData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
  return descriptor.value;
}

/**
 * Read an own DATA property that may legitimately be ABSENT.
 *
 * Only `time` is read this way. A comment without a usable timestamp is a comment whose age this
 * layer cannot reason about, so it is dropped — but its absence must not invalidate the whole
 * page. An ACCESSOR still throws: a getter is not "absent", it is hostile input.
 */
function optionalData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) invalid();
  return descriptor.value;
}

function requireText(value) {
  if (typeof value !== 'string' || value.trim().length === 0) invalid();
  return value;
}

/**
 * Filter an already-authorised comment page down to what may be shown.
 *
 * @param {object} page  `{ author, postId, comments: [{id, author, time, content}] }`, as produced
 *   by `projectQzoneOnebotMsgDetail`. Times are epoch MILLISECONDS (the projection converts).
 * @param {{author: string, postId: string}} scope  the SNAPSHOTTED scope, never model input.
 * @param {number} now  trusted clock; a comment dated after it is refused.
 * @returns {{parent: {author: string, postId: string}, comments: object[]}|null}
 *   `null` when the page does not belong to this scope. That is a REFUSAL, not an empty page —
 *   the caller must not report "no comments" for a page it was never allowed to read.
 * @throws {TypeError} on a malformed page. A structurally broken response is not "no comments":
 *   silently returning an empty list would make a platform or transport defect look like an
 *   ordinary quiet post.
 */
export function filterOfflineCommentPage(page, scope, now) {
  if (!Number.isFinite(now)) invalid();
  if (!isPlainRecord(scope) || !isPlainRecord(page)) invalid();
  const scopeAuthor = requireText(ownData(scope, 'author'));
  const scopePostId = requireText(ownData(scope, 'postId'));
  const author = requireText(ownData(page, 'author'));
  const postId = requireText(ownData(page, 'postId'));
  const raw = ownData(page, 'comments');
  if (!Array.isArray(raw)) invalid();

  // A page about a different post or a different author is not this scope's page. Answering
  // `null` (rather than `[]`) keeps that distinct from "the page was empty".
  if (author !== scopeAuthor || postId !== scopePostId) return null;

  const comments = [];
  for (let index = 0; index < raw.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    const entry = descriptor.value;
    if (!isPlainRecord(entry)) invalid();
    const id = requireText(ownData(entry, 'id'));
    const commentAuthor = requireText(ownData(entry, 'author'));
    const time = optionalData(entry, 'time');
    const commentContent = ownData(entry, 'content');
    if (typeof commentContent !== 'string') invalid();
    // A comment with no usable timestamp is DROPPED rather than refused: the projection already
    // rejects a non-integer time, so reaching this with a non-finite one means the comment is
    // outside any window we can reason about. `typeof` is checked because `NaN` is a number.
    if (typeof time !== 'number' || !Number.isFinite(time)) continue;
    if (time > now) continue;
    if (time < now - SEVEN_DAYS_MS) continue;
    // Rebuilt field-by-field into EXACTLY the shape `filterOfflineOwnNewComment` produces
    // ({id, author, time, content}) so a consumer cannot tell the two scopes apart by shape.
    // `name` is not carried: it is a display label from the platform, not an identity this layer
    // can vouch for, and a consumer that needs a nickname must resolve it through its own path.
    comments.push(Object.freeze({ id, author: commentAuthor, time, content: commentContent }));
  }
  return Object.freeze({
    parent: Object.freeze({ author: scopeAuthor, postId: scopePostId }),
    comments: Object.freeze(comments),
  });
}

export { COMMENT_FIELDS as _COMMENT_FIELDS, SEVEN_DAYS_MS as _SEVEN_DAYS_MS };