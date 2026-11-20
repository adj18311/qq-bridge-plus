import { canReadPost } from './qzone-policy-offline.mjs';

// Metadata and scope must be constructed from trusted, verified platform
// evidence; accepting model-provided metadata would bypass this check.
// This offline decision does not itself fetch or filter any comments.
export function allowOfflineComments(target, metadata, scope) {
  if (!target || !metadata || typeof target.author !== 'string' || !target.author ||
      typeof target.id !== 'string' || !target.id || metadata.author !== target.author ||
      metadata.id !== target.id) return false;
  return canReadPost(metadata, scope);
}
