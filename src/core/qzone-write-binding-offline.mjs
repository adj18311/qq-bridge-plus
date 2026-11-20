import { buildQzoneOnebotWriteRequest } from './qzone-onebot-write-contract.mjs';
import { formatAuditRecord, isSafeQzoneAuditId } from './qzone-audit-offline.mjs';

const pending = new WeakMap();
const usedIds = new Set();
const CONTEXT_FIELDS = new Set(['time', 'source', 'target', 'result', 'reason', 'quota']);
const ACTIONS = new Set(['publish', 'comment', 'reply', 'like']);

function copyContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(context))) throw new TypeError('invalid audit context');
  const copy = Object.create(null);
  for (const key of Reflect.ownKeys(context)) {
    const descriptor = Object.getOwnPropertyDescriptor(context, key);
    if (typeof key !== 'string' || !CONTEXT_FIELDS.has(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('invalid audit context');
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

function freezeRequest(request) {
  if (Array.isArray(request.params.target_uins)) Object.freeze(request.params.target_uins);
  Object.freeze(request.params);
  return Object.freeze(request);
}

// Process-local experiment only. The capability is neither persisted nor
// recoverable after process loss; it does not authorize transport dispatch.
export function createQzoneWriteBinding(id, kind, input, auditContext) {
  if (!isSafeQzoneAuditId(id) || usedIds.has(id)) throw new TypeError('invalid or reused operation id');
  if (!ACTIONS.has(kind)) throw new TypeError('invalid action');

  // Build exactly once. This validates allowed request fields and produces a
  // fresh normalized value detached from caller-owned objects.
  const request = buildQzoneOnebotWriteRequest(kind, input);
  const context = copyContext(auditContext);
  if (context.result !== 'unknown' || typeof context.target !== 'string') throw new TypeError('invalid audit context');
  const params = request.params;
  // Publish identity still requires an independently trusted bot identity.
  if (kind !== 'publish' && context.target !== String(params.target_uin)) throw new TypeError('audit target mismatch');
  const audit = formatAuditRecord({
    ...context,
    action: kind,
    postId: params.tid ?? null,
    commentId: kind === 'reply' ? params.comment_id : null,
    content: typeof params.content === 'string' ? params.content : '',
    reason: context.reason ?? '',
    result: 'unknown',
  });
  if ((audit.redacted && audit.content !== '[REDACTED]') ||
      (!audit.redacted && audit.content !== (params.content ?? '')) ||
      audit.action !== kind || audit.postId !== (params.tid ?? null) ||
      audit.commentId !== (kind === 'reply' ? params.comment_id : null)) throw new TypeError('audit binding mismatch');

  freezeRequest(request);
  const capability = Object.freeze(Object.create(null));
  pending.set(capability, { id, request, context, audit });
  usedIds.add(id);
  return Object.freeze({ id, audit: Object.freeze(audit), capability });
}

export function takeQzoneWriteRequest(id, capability) {
  if (!capability || (typeof capability !== 'object' && typeof capability !== 'function')) throw new TypeError('invalid capability');
  const entry = pending.get(capability);
  if (!entry || entry.id !== id) throw new TypeError('invalid or consumed capability');
  pending.delete(capability);
  return entry.request;
}

// Consume the same one-shot private capability while retaining the exact
// frozen request and the audit inputs from which its safe projection was made.
// Callers cannot manufacture a capability that passes the WeakMap lookup.
export function consumeQzoneWriteBinding(id, capability) {
  if (!capability || (typeof capability !== 'object' && typeof capability !== 'function')) throw new TypeError('invalid capability');
  const entry = pending.get(capability);
  if (!entry || entry.id !== id) throw new TypeError('invalid or consumed capability');
  pending.delete(capability);
  const params = entry.request.params;
  const auditInput = Object.freeze({
    ...entry.context,
    action: entry.audit.action,
    postId: params.tid ?? null,
    commentId: entry.audit.commentId,
    content: typeof params.content === 'string' ? params.content : '',
    reason: entry.context.reason ?? '',
    result: 'unknown',
  });
  return Object.freeze({ id: entry.id, request: entry.request, auditInput, audit: entry.audit });
}
