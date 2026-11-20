import { authorizeTool } from './qzone-policy-offline.mjs';

const TOOLS = new Set(['read_posts', 'read_comments', 'publish', 'comment', 'reply', 'like']);
const DENIED = 'qzone tool denied';

/**
 * Runtime switch/circuit-breaker gate for a future tool-call wiring point.
 * State is fetched and authorized for every invocation, including invocations
 * through handlers created before close(). This module does not handle quotas,
 * trusted-source checks, tool registration, or dispatch.
 * This check is not an atomic gate across processes: configuration can change
 * after readState() returns. The real send path must check again inside its
 * reservation/dispatch transaction immediately before dispatch.
 */
export function createQzoneToolGate({ readState } = {}) {
  if (typeof readState !== 'function') throw new TypeError('invalid qzone tool gate dependencies');
  let closed = false;

  return Object.freeze({
    wrap(tool, handler) {
      if (!TOOLS.has(tool)) throw new TypeError('invalid qzone tool');
      if (typeof handler !== 'function') throw new TypeError('invalid qzone tool handler');
      return async function gatedQzoneTool(...args) {
        if (closed) throw new Error(DENIED);
        try {
          const state = await readState();
          // Re-check lifecycle after the async read so close() wins while it waits.
          if (closed || !state || typeof state !== 'object' ||
              !authorizeTool(state, tool).allowed) throw new Error(DENIED);
        } catch {
          throw new Error(DENIED);
        }
        return handler.apply(this, args);
      };
    },
    close() { closed = true; },
  });
}
