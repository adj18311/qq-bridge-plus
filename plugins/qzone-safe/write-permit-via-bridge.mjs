// The PLUGIN-SIDE adapter for the BRIDGE-HELD one-time write permit (C6, task A).
//
// WHAT CHANGED AND WHY
// --------------------
// C4 put the permit registry in the PLUGIN process. That stopped a replay of an approved operation,
// but not the thing the ruling actually names: a process holding the long-lived bearer token could
// still ask `POST /api/qzone/onebot` to write, because the registry that would refuse it lived on
// the CALLER's side of the trust boundary. The registry therefore moves to the BRIDGE, and this
// module is the plugin's client for it.
//
// THE ONE HARD CONSTRAINT: SYNC VERSUS ASYNC
// -------------------------------------------
// `createPermitGatedTransport` (`src/core/qzone-write-permit-offline.mjs:248`) calls `issue` and
// `consume` SYNCHRONOUSLY. An IPC client cannot answer synchronously, so that gate cannot sit in
// front of an async registry — a Promise handed to its `typeof permitId !== 'string'` check fails
// closed on EVERY write, which would look like "the permit channel is down" forever.
//
// So this module supplies the ASYNC TWIN of that gate: `createAsyncPermitGatedTransport`. Same
// rule (resolve the approved binding -> issue -> consume -> and only then call the transport,
// once), same refusal vocabulary (`write-permit-unapproved` / `write-permit-unavailable` /
// `write-permit-refused`), same `{ notSent: true, reason }` shape — but it `await`s the two registry
// calls, because the write path already awaits the transport closure it produces. The synchronous
// gate in `src/core` is deliberately left untouched: it still serves an in-process registry.
//
// WHY THIS IS NOT A WEAKER GATE
// ------------------------------
// Awaiting between `issue` and `consume` adds a suspension point the synchronous gate did not have.
// Nothing here depends on the absence of one: each dispatch resolves its OWN binding (the approved
// operation's `authorizationId`), mints its OWN permit, and the BRIDGE refuses a second consume of
// that permit no matter which call presents it. Two interleaved dispatches therefore cannot share a
// permit — a permit id is only ever handed to the call that minted it.
//
// ⚠️ WHAT THIS FILE DOES NOT DO: it does not start, configure or authenticate the bridge-side
// listener, and it never reads a credential from disk. `origin`/`token` are injected by the host.
// The bridge-side module (`src/qzone-write-permit-ipc.mjs`) is loaded LAZILY so this file can be
// exercised before that module lands; a missing module is a clear, actionable error, never a silent
// "no permit" downgrade.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TOKEN = /^[\x21-\x7E]{16,512}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
/** Where the bridge-side singleton lives, relative to this plugin file. */
const BRIDGE_MODULE = new URL('../../src/qzone-write-permit-ipc.mjs', import.meta.url).href;

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function readLoopbackOrigin(value) {
  if (typeof value !== 'string') return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!['127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  return parsed.origin;
}

/**
 * Wrap a client that already satisfies the C6 contract, or build one from the bridge module.
 *
 * @param {object} options
 * @param {string} [options.origin]  loopback origin of the bridge.
 * @param {string} [options.token]   bearer token for the permit channel.
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetch]
 * @param {{issue: Function, consume: Function, close?: Function}} [options.client]
 *   an ALREADY-BUILT client. This is the seam the C6 tests use to stand in for the bridge process;
 *   when it is omitted the real bridge module is imported lazily and asked for one.
 * @returns {Promise<{issue: Function, consume: Function, close: Function}>}
 * @throws {TypeError} on a mistyped dependency or a missing bridge module. Never returns a
 *   "no permit" stub: a permit client that silently refuses everything would look like a working
 *   channel that denies every write.
 */
export async function createWritePermitViaBridge({ origin, token, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchOption, client } = {}) {
  let built = client;
  if (built === undefined) {
    const base = readLoopbackOrigin(origin);
    if (base === null) {
      throw new TypeError('write permit client needs a loopback http origin such as http://127.0.0.1:3100');
    }
    if (typeof token !== 'string' || TOKEN.test(token) === false) {
      throw new TypeError('write permit client needs a 16-512 character printable bearer token');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new TypeError('write permit client needs a timeoutMs between 1 and ' + MAX_TIMEOUT_MS);
    }
    let module;
    try {
      module = await import(BRIDGE_MODULE);
    } catch (error) {
      throw new TypeError(
        'write permit client cannot load ' + BRIDGE_MODULE + ' (' + (error?.code ?? error?.message ?? 'import failed') + '). '
        + 'The bridge-side permit module has not landed yet; pass { client } to inject one.',
      );
    }
    const factory = module?.createQzoneWritePermitIpcClient;
    if (typeof factory !== 'function') {
      throw new TypeError('write permit client: ' + BRIDGE_MODULE + ' does not export createQzoneWritePermitIpcClient');
    }
    built = await factory({
      origin: base,
      token,
      timeoutMs,
      ...(fetchOption === undefined ? {} : { fetch: fetchOption }),
    });
  }

  if (!isPlainRecord(built) && typeof built !== 'object') {
    throw new TypeError('write permit client must be an object with issue/consume');
  }
  if (typeof built.issue !== 'function' || typeof built.consume !== 'function') {
    throw new TypeError('write permit client must expose issue/consume');
  }

  const close = typeof built.close === 'function' ? built.close.bind(built) : async () => {};
  return Object.freeze({
    // Both are async by contract; the returned object is the registry shape the ASYNC gate below
    // expects. It is NOT a drop-in for the synchronous `createPermitGatedTransport`.
    issue: (binding) => built.issue(binding),
    consume: (request) => built.consume(request),
    close,
  });
}


/**
 * Fail EARLY when the bridge-side permit module is not present.
 *
 * The assembly's constructor is synchronous, so it cannot `await` the lazy import to find out
 * whether the bridge half exists. It CAN answer the question that matters — is the module there at
 * all — because that is a filesystem fact. Throwing here means a host that configured a permit
 * channel learns about a missing bridge module at STARTUP, path and all, instead of watching every
 * write fail later with `write-permit-unavailable`.
 *
 * @returns {string} the resolved absolute path of the bridge module.
 * @throws {TypeError} when the module is absent.
 */
export function assertBridgePermitModuleAvailable() {
  const file = fileURLToPath(BRIDGE_MODULE);
  if (!existsSync(file)) {
    throw new TypeError(
      'write permit channel is configured but ' + file + ' does not exist. '
      + 'The bridge-side permit module has not landed yet; either install it or omit writePermitChannel.',
    );
  }
  return file;
}

/**
 * A SYNCHRONOUSLY constructed client whose `issue`/`consume` are async.
 *
 * WHY THIS EXISTS: `createQzoneHostAssembly` is a synchronous factory and the bridge client is
 * loaded through a dynamic `import`. Building it lazily keeps the assembly's contract intact while
 * still refusing to invent a stub: every call awaits the SAME cached promise, so the module is
 * imported once, and an import failure rejects the call — which the async gate turns into a closed
 * `write-permit-unavailable`, never into an approval.
 *
 * @param {{origin: string, token: string, timeoutMs?: number, fetch?: Function}} channel
 * @returns {{issue: Function, consume: Function, close: Function}}
 */
export function createLazyWritePermitClient({ origin, token, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchOption } = {}) {
  let pending = null;
  const ready = () => {
    if (pending === null) {
      // Built once, on first use. A REJECTED promise is cached too: retrying the import on every
      // write would turn a configuration error into a load storm and would still fail.
      pending = createWritePermitViaBridge({
        origin, token, timeoutMs, ...(fetchOption === undefined ? {} : { fetch: fetchOption }),
      });
    }
    return pending;
  };
  return Object.freeze({
    async issue(binding) {
      const client = await ready();
      return client.issue(binding);
    },
    async consume(request) {
      const client = await ready();
      return client.consume(request);
    },
    async close() {
      if (pending === null) return;
      let client;
      try { client = await pending; } catch { return; }
      try { await client.close(); } catch { /* sockets are already gone */ }
    },
  });
}

/**
 * The ASYNC twin of `createPermitGatedTransport` — see the header for why a twin is required.
 *
 * Rule, in order:
 *   1. `resolveBinding(dispatch)` returns the APPROVED `{authorizationId, inputDigest}`, or null.
 *      Null means "no approval on record" and the write is refused WITHOUT a permit existing.
 *   2. `issue` -> `consume`. Any refusal revokes the doomed permit (best effort) and refuses.
 *   3. Only after a successful consume is `transport` called — exactly once, never retried.
 *
 * The refusal shape is `{ notSent: true, reason }`, the one shape the write path classifies as
 * "provably never left this process" (`qzone-write-settlement-offline.mjs:105-151`). Note it does
 * NOT refund the quota unit: the write path calls its transport after the reservation and nothing
 * refunds there — the caller sees `quotaConsumed:true` and that is reported, not hidden.
 *
 * @throws {TypeError} when a dependency is missing or mistyped (construction time only).
 */
export function createAsyncPermitGatedTransport({ writePermit, resolveBinding, transport } = {}) {
  if (writePermit === null || typeof writePermit !== 'object'
      || typeof writePermit.issue !== 'function' || typeof writePermit.consume !== 'function') {
    throw new TypeError('async permit gate needs a registry with issue/consume');
  }
  if (typeof resolveBinding !== 'function') {
    throw new TypeError('async permit gate needs a resolveBinding function');
  }
  if (typeof transport !== 'function') {
    throw new TypeError('async permit gate needs a transport function');
  }

  return async function asyncPermitGatedTransport(dispatch) {
    let binding = null;
    try {
      binding = await resolveBinding(dispatch);
    } catch {
      binding = null;
    }
    const authorizationId = binding?.authorizationId;
    const inputDigest = binding?.inputDigest;
    if (typeof authorizationId !== 'string' || typeof inputDigest !== 'string') {
      return { notSent: true, reason: 'write-permit-unapproved' };
    }

    let permitId;
    try {
      permitId = await writePermit.issue({ authorizationId, inputDigest });
    } catch {
      permitId = null;
    }
    if (typeof permitId !== 'string' || permitId.length === 0) {
      return { notSent: true, reason: 'write-permit-unavailable' };
    }

    let spent = false;
    try {
      spent = (await writePermit.consume({ permitId, authorizationId, inputDigest })) === true;
    } catch {
      spent = false;
    }
    if (spent !== true) {
      try { await writePermit.revoke?.(permitId); } catch { /* a doomed permit cannot be used */ }
      return { notSent: true, reason: 'write-permit-refused' };
    }
    // Spent at the BRIDGE. Whatever happens below — success, a platform refusal, or a thrown
    // `unknown` — there is no second permit for this operation.
    return transport(dispatch);
  };
}