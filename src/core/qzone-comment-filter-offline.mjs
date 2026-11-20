import { allowOfflineComments } from './qzone-read-boundary-offline.mjs';

function validIdentity(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeComment(comment) {
  if (!comment || typeof comment !== 'object' || Array.isArray(comment)) return null;
  const { id, author, time, content } = comment;
  if (!validIdentity(id) || !validIdentity(author) || !Number.isFinite(time) || typeof content !== 'string') return null;
  return { id, author, time, content };
}

// Filters an already obtained offline page. Metadata and scope must be
// independently verified by the caller; this does not prevent upstream fetches.
// Model assertions are never used as identity or authorization evidence.
export function filterOfflineComments(target, metadata, scope, page) {
  if (!target || !metadata || !scope || !page ||
      !validIdentity(target.author) || !validIdentity(target.id) ||
      !validIdentity(metadata.author) || !validIdentity(metadata.id) ||
      !validIdentity(page.author) || !validIdentity(page.postId) ||
      !Array.isArray(page.comments) ||
      page.author !== target.author || page.postId !== target.id ||
      !allowOfflineComments(target, metadata, scope)) return [];

  return page.comments.map(safeComment).filter((comment) => comment !== null);
}
