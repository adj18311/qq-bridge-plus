// Projects only an already authenticated OneBot response. It cannot verify
// source identity, audit an operation, or prove platform delivery independently.
const UNKNOWN = Object.freeze({ outcome: 'unknown' });
const ACTIONS = new Set(['publish', 'like', 'comment', 'reply']);

function value(record, name) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(record))) throw new TypeError('invalid record');
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('invalid field');
  return descriptor.value;
}

export function projectQzoneWriteResult(action, response) {
  try {
    if (!ACTIONS.has(action) || value(response, 'status') !== 'ok' || value(response, 'retcode') !== 0) return UNKNOWN;
    const data = value(response, 'data');
    if (action === 'like') return data === null ? { outcome: 'success' } : UNKNOWN;
    if (action === 'publish') {
      const postId = value(data, 'tid');
      const time = value(data, 'time');
      if (typeof postId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(postId) ||
          !Number.isSafeInteger(time) || time < 0) return UNKNOWN;
      return { outcome: 'success', postId };
    }
    const commentId = value(data, 'comment_id');
    if (typeof commentId !== 'string' || (commentId !== '' && !/^[A-Za-z0-9_-]{1,128}$/.test(commentId))) return UNKNOWN;
    return commentId === '' ? { outcome: 'success' } : { outcome: 'success', commentId };
  } catch {
    return UNKNOWN;
  }
}
