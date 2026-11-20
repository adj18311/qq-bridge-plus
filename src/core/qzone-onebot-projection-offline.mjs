const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_UNIX_SECONDS = MAX_DATE_MS / 1000;
// Application-side identifier constraint; the upstream list schema does not guarantee this format.
const TID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const INVALID_RESPONSE = 'invalid qzone OneBot list response';

function invalidResponse() {
  throw new TypeError(INVALID_RESPONSE);
}

function requireRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidResponse();
  return value;
}

function readDataProperty(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalidResponse();
  return descriptor.value;
}

function normalizeTarget(targetQq) {
  let value;
  if (typeof targetQq === 'number') {
    value = targetQq;
  } else if (typeof targetQq === 'string' && /^\d+$/.test(targetQq)) {
    value = Number(targetQq);
    if (String(value) !== targetQq) invalidResponse();
  } else {
    invalidResponse();
  }

  if (!Number.isSafeInteger(value) || value <= 0) invalidResponse();
  return String(value);
}

function requireNow(now) {
  if (!Number.isSafeInteger(now) || Math.abs(now) > MAX_DATE_MS) invalidResponse();
  return now;
}

// One image URL: http(s) only, bounded length. The platform hands back photo-store links; anything
// else (data:, file:, javascript:, an oversized string) is dropped rather than forwarded — the
// list is shown to a model, and a non-http scheme there is an injection surface, not a picture.
const IMAGE_URL_MAX = 2048;
function projectImage(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > IMAGE_URL_MAX) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return value;
}

/**
 * Read the `images` array off a row.
 *
 * `images` is OPTIONAL in the upstream payload — an earlier revision simply never read it, so every
 * read reported `posts` with no media at all and the model could not answer "what is in this post".
 * A row whose `images` is absent or not an array is treated as "no images" rather than as an
 * invalid response: the field is advisory, and refusing the whole read over it would break posts
 * that carry none. Individual entries are filtered by `projectImage`.
 */
function projectImages(row) {
  const descriptor = Object.getOwnPropertyDescriptor(row, 'images');
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return Object.freeze([]);
  const raw = descriptor.value;
  if (!Array.isArray(raw)) return Object.freeze([]);
  const out = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!entry || !Object.hasOwn(entry, 'value')) continue;
    const url = projectImage(entry.value);
    if (url !== null) out.push(url);
  }
  return Object.freeze(out);
}

function projectRow(target, row, now) {
  requireRecord(row);
  const id = readDataProperty(row, 'tid');
  const content = readDataProperty(row, 'content');
  const seconds = readDataProperty(row, 'time');

  if (typeof id !== 'string' || !TID_PATTERN.test(id)) invalidResponse();
  if (typeof content !== 'string') invalidResponse();
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_UNIX_SECONDS) invalidResponse();

  const time = seconds * 1000;
  if (!Number.isSafeInteger(time) || time > now) invalidResponse();

  return { author: target, id, time, content, images: projectImages(row) };
}

/**
 * Project a successful OneBot Qzone list envelope into a minimal offline view.
 * `author` marks the trusted requested target; this does not verify returned identity.
 */
function projectMsgList(targetQq, response, now) {
  const target = normalizeTarget(targetQq);
  const timestampNow = requireNow(now);
  const envelope = requireRecord(response);

  if (readDataProperty(envelope, 'status') !== 'ok' || readDataProperty(envelope, 'retcode') !== 0) {
    invalidResponse();
  }

  const data = requireRecord(readDataProperty(envelope, 'data'));
  const total = readDataProperty(data, 'total');
  if (!Number.isSafeInteger(total) || total < 0) invalidResponse();
  const list = readDataProperty(data, 'msglist');
  if (!Array.isArray(list) || list.length > 100) invalidResponse();

  const projected = [];
  for (let index = 0; index < list.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalidResponse();
    projected.push(projectRow(target, descriptor.value, timestampNow));
  }
  return projected;
}

/**
 * Project a fixed OneBot success envelope without exposing validation details
 * or raw response values through thrown errors.
 */
export function projectQzoneOnebotMsgList(targetQq, response, now) {
  try {
    return projectMsgList(targetQq, response, now);
  } catch {
    throw new TypeError(INVALID_RESPONSE);
  }
}
