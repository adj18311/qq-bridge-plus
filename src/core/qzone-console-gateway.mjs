import { verifySession } from './console-column-auth.mjs';
import { createQzoneColumnAuthRouteOffline } from './qzone-column-auth-route-offline.mjs';
import { createOfflineColumnAuthAudit } from './qzone-column-auth-audit-offline.mjs';
import { createOfflineQzoneAdminRouter } from './qzone-admin-router-offline.mjs';
import { formatAuditRecord } from './qzone-audit-offline.mjs';

const PREFIX = '/api/console/qqspace-column';

/**
 * Project one `state.writeAudit` row for the console.
 *
 * The settle rows are recorded by `createQzoneWriteAudit` (plugin side) and carry the settlement
 * fields, not the `formatAuditRecord` shape. Projecting them through `formatAuditRecord` would
 * INVENT fields it does not have (source/target/pauseScope/content redaction), so this keeps the
 * row's own vocabulary and only renames nothing. Unknown/extra keys are passed through, because a
 * settle row that gained a field is still that row — dropping it would hide evidence.
 */
function settleRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return Object.freeze({});
  const copy = {};
  for (const key of Reflect.ownKeys(row)) {
    if (typeof key !== 'string') continue;
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) continue;
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}

function snapshot(input, depth = 0) {
  if (input === null || ['string', 'number', 'boolean'].includes(typeof input)) return input;
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 6 || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('invalid request');
  const result = {};
  const keys = Reflect.ownKeys(input);
  if (keys.length > 64 || keys.some((key) => typeof key !== 'string')) throw new TypeError('invalid request');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('invalid request');
    Object.defineProperty(result, key, { enumerable: true, value: snapshot(descriptor.value, depth + 1) });
  }
  return Object.freeze(result);
}

function guard(fn, input) {
  try {
    const value = fn(input);
    if (value === true) return true;
    if (value && (typeof value === 'object' || typeof value === 'function')) Promise.resolve(value).catch(() => {});
    return false;
  } catch { return false; }
}

function cookieValue(headers) {
  const raw = typeof headers?.cookie === 'string' ? headers.cookie : '';
  let found = null;
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== 'qqspace_column_session') continue;
    if (found !== null) return '';
    try { found = decodeURIComponent(part.slice(index + 1).trim()); } catch { return ''; }
  }
  return found ?? '';
}

/** Framework-neutral gateway. Caller must supply a trusted store, principal
 * guards, request size limit and transport. Never expose this directly to MCP. */
// OPTIONAL `pluginStore` — a handle on the PLUGIN's own database (t55). When supplied, /status,
// /config and /audit project THAT database and the four management routes write to it, which is the
// only way this console can show (or change) what the QQ-space plugin actually does. `store` keeps
// backing the CONSOLE database: column-password auditing and audit pruning are bound to it.
//
// Omitted / null is byte-identical to before, which is what every pre-existing caller gets.
//
// ⚠️ THE SIGNATURE MUST STAY COMMENT-FREE BELOW THIS LINE: test-qzone-console-dispatch-status.mjs
// parses the destructured parameter list and splits it on commas; a comment containing a comma
// inside the braces is read as parameter names and breaks that canary.
export function createQzoneConsoleGateway({
  store, stateDir, selfId, consoleToken, authorizeConsole, verifyCsrf, isAgentPaused,
  now = Date.now, enableAuditFaultRestore = false, operationApprovals, pluginStore,
} = {}) {
  if (typeof authorizeConsole !== 'function' || typeof verifyCsrf !== 'function' || typeof now !== 'function') throw new TypeError('invalid gateway dependencies');
  // `operationApprovals` NO LONGER HAS A ROUTE TO ATTACH TO (t55). The option is still ACCEPTED and
  // still validated so that an existing caller passing a broker does not start throwing on upgrade,
  // but it is deliberately unused: the route it fed was deleted.
  //
  // Stated plainly rather than left implicit: a caller can pass a perfectly good broker and see NO
  // approval behaviour at all. That is the correct outcome here — human approval was removed on
  // purpose — and keeping the shape check means a malformed one is still a loud TypeError instead of
  // being ignored.
  if (operationApprovals !== undefined && (!operationApprovals ||
      typeof operationApprovals.listPending !== 'function' || typeof operationApprovals.decide !== 'function')) {
    throw new TypeError('invalid operation approvals');
  }
  // CONSTRUCTION-TIME OPT-IN, EXPLICIT BOOLEAN ONLY (same rule the router enforces).
  //
  // This option decides whether `/audit/fault/restore` exists at all, and that route can clear a
  // write fault — so it must not be derivable from anything a request carries. It is read HERE, from
  // the constructor argument, and nowhere else: no body field, query string, header or session
  // property reaches it. `'true'`, `1`, `null` and `{}` are refused rather than coerced, because a
  // coerced truthy value would enable a fault-clearing route that the caller never asked for.
  //
  // The default is `false` and the router's default is `false` too, so a caller that does not pass it
  // (src/bridge.js and every other existing construction site) gets byte-identical behaviour: the
  // route is absent and answers 404 exactly as before.
  if (typeof enableAuditFaultRestore !== 'boolean') throw new TypeError('invalid enableAuditFaultRestore');
  const auth = createQzoneColumnAuthRouteOffline({ stateDir, consoleToken, authorizeConsole: () => true,
    verifyCsrf: () => true, isAgentPaused, now, audit: createOfflineColumnAuthAudit(store, { selfId }) });
  // The REAL `store` handle is forwarded verbatim — not a closure double, not a wrapper. M9's
  // `requireAuthority` needs the handle that carries this database's send authority, and a
  // hand-built `{read, update}` double would carry none.
  // WHICH DATABASE /audit READS. Same rule the router uses: the PLUGIN's when supplied (that is where
  // the dispatch intent and the write settlement rows actually are), the console's otherwise — which is
  // what every pre-existing caller gets, so nothing changes for them.
  // TRI-STATE, same rule as the router: `undefined` = not asked for (fall back to `store`), `null` =
  // asked for but the plugin database is missing (every plugin-backed route must FAIL rather than
  // serve the console database's stale rows), handle = use it.
  const pluginConfigured = pluginStore !== undefined;
  const auditStore = pluginConfigured ? pluginStore : store;
  const admin = createOfflineQzoneAdminRouter({
    store, pluginStore, selfId, clock: now, enableAuditFaultRestore, authenticate: ({ sessionToken }) => {
      const time = now();
      if (!Number.isFinite(time)) return { valid: false, operator: 'invalid' };
      // UNCHANGED: the session check stays exactly as it was. This option must not weaken
      // authentication, so it is not consulted here in any form.
      const session = verifySession({ sessionToken, namespace: 'qqspace', now: time });
      return session.ok ? { valid: true, operator: session.sessionId } : { valid: false, operator: 'invalid' };
    },
  });
  return async function gateway(input) {
    let request;
    try { request = snapshot(input); } catch { return { status: 400, body: { ok: false, error: 'invalid-request' } }; }
    if (!guard(authorizeConsole, request)) return { status: 403, body: { ok: false, error: 'console-auth-required' } };
    if (!guard(verifyCsrf, request)) return { status: 403, body: { ok: false, error: 'csrf-required' } };
    if (typeof request.pathname !== 'string' || !request.pathname.startsWith(`${PREFIX}/`)) return { status: 404, body: { ok: false, error: 'not-found' } };
    if (request.pathname.startsWith(`${PREFIX}/auth/`)) return auth(request);
    // `/operation-approvals` IS GONE (t55, operator ruling: no human approval).
    //
    // It used to exist only when a factory was supplied at construction. In production nobody ever
    // supplied one (`cfg.qzone.consoleApprovals` and `cfg.qzone.approvalIpc` are both absent), so the
    // route answered 404 — and a 404 that MEANS "we deliberately removed this" is indistinguishable
    // from a typo. Deleting the branch removes the option's only reason to exist; the route now falls
    // through to the admin router and 404s as an unknown path, exactly like any other.
    if (request.pathname === `${PREFIX}/audit`) {
      if (request.method !== 'GET' || request.body !== undefined) return { status: 405, body: { ok: false, error: 'method-not-allowed' } };
      try {
        const time = now();
        if (!Number.isFinite(time) || !verifySession({ sessionToken: cookieValue(request.headers), namespace: 'qqspace', now: time }).ok) {
          return { status: 401, body: { ok: false, error: 'unauthorized' } };
        }
        // TWO SINKS, ONE TABLE (operator ruling D6). The plugin keeps its dispatch/dispatch-outcome rows
        // in `state.audit` and its write SETTLEMENTS in `state.writeAudit`; they answer different
        // questions ("what was attempted" vs "what reached the platform and how it resolved"), so the
        // console shows both in one list and tags each row rather than merging them silently.
        //
        // A CONFIGURED-BUT-MISSING plugin database is not an empty one: say so, do not return [].
        if (pluginConfigured && auditStore === null) {
          return { status: 503, body: { ok: false, error: 'plugin-state-unavailable' } };
        }
        // NOTHING IS FABRICATED: a database without `writeAudit` yields intent rows only, and a
        // database without `audit` yields settle rows only. A missing sink is not an empty sink.
        const state = auditStore.read();
        const records = [];
        if (Array.isArray(state.audit)) {
          for (const entry of state.audit.slice(-100)) {
            const record = formatAuditRecord(entry.record);
            if (entry.record.redacted === true) record.redacted = true;
            records.push({ kind: 'intent', ...record });
          }
        }
        if (Array.isArray(state.writeAudit)) {
          for (const row of state.writeAudit.slice(-100)) {
            records.push({ kind: 'settle', ...settleRow(row) });
          }
        }
        return { status: 200, body: { ok: true, records } };
      } catch (error) {
        if (/database is locked|SQLITE_BUSY/i.test(String(error?.message ?? ''))) {
          return { status: 503, body: { ok: false, error: 'plugin-busy' } };
        }
        return { status: 500, body: { ok: false, error: 'audit-unavailable' } };
      }
    }
    const result = await admin({ method: request.method, path: request.pathname.slice(PREFIX.length),
      sessionToken: cookieValue(request.headers), ...(request.body === undefined ? {} : { body: request.body }) });
    // NO DISPATCH BINDING HAS EVER BEEN WIRED HERE — `isDispatchAvailable` is a constant `false`, and
    // that is a deliberate statement rather than an oversight. (Terminal review F3: an earlier comment
    // claimed the option "used to be reachable here"; `git log -S isDispatchAvailable -- src` and
    // `git grep HEAD -- src` are both empty, so `src/` never carried one. The claim was wrong and is
    // corrected rather than preserved.) The console runtime therefore never forwards a dispatch
    // option, and `test-qzone-console-dispatch-status.mjs` enforces that with a structural canary on
    // both signatures. A future wiring change has to edit this line on purpose.
    if (request.method === 'GET' && request.pathname === `${PREFIX}/status` && result.status === 200) {
      return { ...result, body: { ...result.body, dispatchAvailable: false } };
    }
    return result;
  };
}
