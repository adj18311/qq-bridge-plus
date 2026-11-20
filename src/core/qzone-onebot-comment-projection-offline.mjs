const INVALID = 'invalid qzone OneBot detail response';
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_UNIX_SECONDS = Math.floor(MAX_DATE_MS / 1000);
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function invalid() { throw new TypeError(INVALID); }

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value;
}

function field(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
  return descriptor.value;
}

function requiredString(value, pattern = null) {
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) invalid();
  return value;
}

function qq(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0 || String(number) !== value) invalid();
    return String(number);
  }
  if (!Number.isSafeInteger(value) || value <= 0) invalid();
  return String(value);
}

function commentId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) invalid();
    value = String(value);
  }
  return requiredString(value, ID);
}

function commentTime(value, now) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UNIX_SECONDS || value * 1000 > now) invalid();
  return value * 1000;
}

function list(value, maxLength = Infinity) {
  if (!Array.isArray(value) || value.length > maxLength) invalid();
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    result.push(descriptor.value);
  }
  return result;
}

function projectComment(input, now) {
  const source = record(input);
  const id = commentId(field(source, 'comment_id'));
  const author = qq(field(source, 'uin'));
  // SnowLuma's detail mapper requires a name, although the downstream filter
  // contract deliberately excludes it.
  requiredString(field(source, 'name'));
  const time = commentTime(field(source, 'time'), now);
  const content = requiredString(field(source, 'content'));
  return { id, author, time, content };
}

function projectDetail(targetQq, expectedPostId, response, now) {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS) invalid();
  const target = qq(targetQq);
  const expectedId = requiredString(expectedPostId, ID);
  const envelope = record(response);
  if (field(envelope, 'status') !== 'ok' || field(envelope, 'retcode') !== 0) invalid();

  const data = record(field(envelope, 'data'));
  const postId = requiredString(field(data, 'tid'), ID);
  if (postId !== expectedId) invalid();
  requiredString(field(data, 'content'));
  const commentCount = field(data, 'comment_num');
  if (!Number.isSafeInteger(commentCount) || commentCount < 0) invalid();

  const comments = [];
  let contentBytes = 0;
  for (const rawComment of list(field(data, 'comments'), 100)) {
    const source = record(rawComment);
    const parent = projectComment(source, now);
    const replies = list(field(source, 'replies'), 100);
    if (comments.length + 1 + replies.length > 100) invalid();
    contentBytes += Buffer.byteLength(parent.content, 'utf8');
    if (contentBytes > 1024 * 1024) invalid();
    comments.push(parent);
    for (const rawReply of replies) {
      const replySource = record(rawReply);
      const reply = projectComment(replySource, now);
      contentBytes += Buffer.byteLength(reply.content, 'utf8');
      if (contentBytes > 1024 * 1024) invalid();
      if (commentId(field(replySource, 'parent_comment_id')) !== parent.id ||
          qq(field(replySource, 'parent_comment_uin')) !== parent.author) invalid();
      comments.push(reply);
    }
  }
  return { author: target, postId, comments };
}

/**
 * Project a successful SnowLuma get_qzone_msg_detail envelope into the page
 * shape consumed by the offline comment filters. `targetQq` must come from
 * trusted request context; the OneBot detail response does not identify its
 * owner. Post metadata for authorization must still come from a trusted source.
 */
export function projectQzoneOnebotMsgDetail(targetQq, expectedPostId, response, now) {
  try {
    return projectDetail(targetQq, expectedPostId, response, now);
  } catch {
    throw new TypeError(INVALID);
  }
}
