import { canReadNewOwnComment } from './qzone-policy-offline.mjs';

// Offline projection only: event and page identity must be independently
// established from a trusted platform event. This cannot limit upstream I/O.
export function filterOfflineOwnNewComment(event, target, page) {
  if (!canReadNewOwnComment(event, target) || !page || page.author !== target.author ||
      page.postId !== target.postId || !Array.isArray(page.comments)) return null;
  const matches = [];
  for (const entry of page.comments) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { id, author, time, content } = entry;
    if (id === target.commentId) matches.push({ id, author, time, content });
  }
  if (matches.length !== 1) return null;
  const comment = matches[0];
  if (typeof comment.author !== 'string' || !comment.author.trim() ||
      !Number.isFinite(comment.time) || typeof comment.content !== 'string') return null;
  return comment;
}
