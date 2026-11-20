import { randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import {
  configureOfflineQzone, resetOfflineQuota, restoreOfflinePause, restoreOfflineAuditFault,
} from './qzone-admin-offline.mjs';
import { formatAuditRecord, isSafeQzoneAuditId } from './qzone-audit-offline.mjs';
import { qzoneOfflineStatus } from './qzone-status-offline.mjs';
import { resetDailyCounter } from './qzone-policy-offline.mjs';

const CONFIG_FIELDS = Object.freeze([
  'enabled', 'readAllowed', 'writeAllowed', 'tools', 'limits',
  'intervalMinutes', 'activeStart', 'activeEnd',
]);
const CONFIG_VIEW_FIELDS = Object.freeze([
  'enabled', 'readAllowed', 'writeAllowed', 'accessPaused', 'writePaused',
  'tools', 'limits', 'intervalMinutes', 'activeStart', 'activeEnd',
]);
const KINDS = new Set(['post', 'comment', 'like']);
const LAYERS = new Set(['access', 'write', 'both']);
const REASONS = new Set(['', 'network', 'not_accessible', 'login_expired', 'captcha', 'rate_limit',
  'quota', 'timeout', 'platform_error', 'policy', 'other']);
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const PROBES = new Set(['waiting', 'claimed', 'manual_only', 'done']);
/**
 * The audit-fault recovery path. NOT in the default route table.
 *
 * `enableAuditFaultRestore` is a CONSTRUCTION-TIME opt-in and defaults to false. Nothing in the
 * request can turn it on: no body field, query string, header or sessionToken is consulted. A caller
 * that never passes the flag cannot reach this handler at all, so the default surface of
 * `createOfflineQzoneAdminRouter` is unchanged.
 *
 * This is a COMPOSITION boundary, not a defence against a host that already controls this process: code
 * that can pass `true` could also call `restoreOfflineAuditFault` directly.
 */
const AUDIT_FAULT_RESTORE_PATH = '/audit/fault/restore';
/** Exactly what `restoreOfflineAuditFault` accepts. Anything else in the body is a 400, never merged. */
const AUDIT_FAULT_REQUEST_FIELDS = Object.freeze(['expectedGeneration', 'expectedLatchRevision']);
const plain = (value) => !!value && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function isOnlyKeys(value, allowed) {
  return plain(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function copyData(value, ancestors = new Set()) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('invalid request data');
    return value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('invalid request data');
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('invalid request data');
  }
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) throw new TypeError('invalid request data');
    if (array) {
      if (keys.length !== value.length + 1 || !keys.includes('length')) throw new TypeError('invalid request data');
      const copy = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('invalid request data');
        copy.push(copyData(descriptor.value, ancestors));
      }
      return Object.freeze(copy);
    }
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('invalid request data');
      Object.defineProperty(copy, key, { value: copyData(descriptor.value, ancestors), enumerable: true });
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

function snapshotRequest(input) {
  const allowed = new Set(['method', 'path', 'body', 'sessionToken']);
  const snapshot = {};
  let valid = true;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
      valid = false;
    }
    for (const key of Reflect.ownKeys(input ?? {})) {
      if (typeof key !== 'string' || !allowed.has(key)) {
        valid = false;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        valid = false;
        continue;
      }
      try {
        Object.defineProperty(snapshot, key, { value: copyData(descriptor.value), enumerable: true });
      } catch {
        valid = false;
      }
    }
  } catch {
    valid = false;
  }
  return { valid, request: Object.freeze(snapshot) };
}

function snapshotAuthentication(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 2 || !keys.includes('valid') || !keys.includes('operator')) return null;
    const valid = Object.getOwnPropertyDescriptor(input, 'valid');
    const operator = Object.getOwnPropertyDescriptor(input, 'operator');
    if (![valid, operator].every((descriptor) => descriptor?.enumerable && Object.hasOwn(descriptor, 'value')) ||
        typeof valid.value !== 'boolean' || typeof operator.value !== 'string' || !IDENTIFIER.test(operator.value)) return null;
    return Object.freeze({ valid: valid.value, operator: operator.value });
  } catch {
    return null;
  }
}

function synchronousUpdateResult(value) {
  if (utilTypes.isPromise(value)) {
    Promise.prototype.then.call(value, undefined, () => {});
    return false;
  }
  return value === undefined || (plain(value) && !Object.hasOwn(value, 'then'));
}

function verifySynchronousUpdate(store) {
  let active = true;
  let calls = 0;
  let result;
  try {
    result = store.update((state) => {
      if (!active) return state;
      calls++;
      return state;
    });
  } finally {
    active = false;
  }
  if (calls !== 1 || !synchronousUpdateResult(result)) throw new TypeError('synchronous store required');
}

function validateManagementState(state, now) {
  qzoneOfflineStatus(state, now);
  resetDailyCounter(state.ledger, 'post');
  if (!Number.isSafeInteger(state.reads) || state.reads < 0 ||
      !Number.isSafeInteger(state.writes) || state.writes < 0 || !PROBES.has(state.probe)) {
    throw new TypeError('invalid management state');
  }
}

function synchronousTransactionStore(store, validateState) {
  return {
    update(transform) {
      verifySynchronousUpdate(store);
      let active = true;
      let calls = 0;
      let result;
      try {
        result = store.update((state) => {
          if (!active) return state;
          calls++;
          if (calls !== 1) return state;
          validateState?.(state);
          return transform(state);
        });
      } finally {
        active = false;
      }
      if (calls !== 1 || !synchronousUpdateResult(result)) throw new TypeError('synchronous store required');
      return result;
    },
  };
}

/** SQLite lock contention, i.e. "another process is writing right now" — NOT a data problem. */
function isBusyError(error) {
  // `node:sqlite` surfaces this as ERR_SQLITE_ERROR with a message containing `database is locked`;
  // `SQLITE_BUSY` appears on some builds. Both mean the same thing to a caller: retry, do not migrate.
  const text = String(error?.message ?? '');
  return /database is locked|SQLITE_BUSY/i.test(text);
}

/**
 * Which fields `qzoneOfflineStatus` needs but the state does not have.
 *
 * WHY A SEPARATE PROBE AND NOT THE THROWN MESSAGE: `qzoneOfflineStatus` throws one generic
 * `invalid qzone status state` for every possible missing field, so an operator reading that cannot
 * tell what to migrate. `qzone-status-offline.mjs` is deliberately NOT changed (its validation is
 * pinned by 13 test files); this function re-states the same requirements READ-ONLY and reports the
 * difference. It never writes and never substitutes a default.
 */
function missingStatusFields(state) {
  const missing = [];
  const has = (key) => state !== null && typeof state === 'object' && Object.hasOwn(state, key);
  for (const key of ['enabled', 'readAllowed', 'writeAllowed', 'accessPaused', 'writePaused']) {
    if (!has(key) || typeof state[key] !== 'boolean') missing.push(key);
  }
  for (const key of ['read_posts', 'read_comments', 'publish', 'comment', 'reply', 'like']) {
    if (!has('tools') || !state.tools || typeof state.tools[key] !== 'boolean') { missing.push('tools.' + key); break; }
  }
  for (const key of ['post', 'comment', 'like']) {
    if (!has('limits') || !state.limits || !Number.isSafeInteger(state.limits[key])) { missing.push('limits.' + key); break; }
  }
  if (!has('ledger') || !state.ledger || !state.ledger.used) missing.push('ledger.used');
  for (const key of ['post', 'comment', 'like']) {
    if (!has('ledger') || !state.ledger?.used || !Number.isSafeInteger(state.ledger.used[key])) { missing.push('ledger.used.' + key); break; }
  }
  if (!has('ledger') || typeof state.ledger?.day !== 'string') missing.push('ledger.day');
  if (!Number.isSafeInteger(state?.intervalMinutes) || state.intervalMinutes < 15) missing.push('intervalMinutes');
  if (!Number.isInteger(state?.activeStart) || !Number.isInteger(state?.activeEnd) || state?.activeStart === state?.activeEnd) {
    missing.push('activeStart/activeEnd');
  }
  return Object.freeze(missing);
}

/**
 * Which fields the MANAGEMENT writes additionally require beyond `missingStatusFields`.
 *
 * `validateManagementState` needs a valid `probe` (it is reset by `manualRestore`) and integer
 * `reads`/`writes`; none of those are part of the status projection, so they are reported
 * separately rather than folded into the same list. Read-only: this never writes and never
 * substitutes a default — a fabricated `probe:'done'` would claim a recovery that never happened.
 */
function missingManagementFields(state) {
  const missing = [...missingStatusFields(state)];
  const state$ = state !== null && typeof state === 'object' ? state : {};
  if (!['waiting', 'claimed', 'manual_only', 'done'].includes(state$.probe)) missing.push('probe');
  for (const key of ['reads', 'writes']) {
    if (!Number.isSafeInteger(state$[key]) || state$[key] < 0) missing.push(key);
  }
  return Object.freeze(missing);
}

function response(status, body) {
  return { status, body };
}

function configProjection(status) {
  const config = Object.fromEntries(CONFIG_VIEW_FIELDS.map((key) => [key, status[key]]));
  config.limits = Object.fromEntries(Object.entries(status.quota).map(([kind, quota]) => [kind, quota.limit]));
  return config;
}

// Offline handler only: callers must bind real routing, CSRF and cookie/session
// policy separately. This module opens no listener and is not registered anywhere.
export function createOfflineQzoneAdminRouter({
  store, clock, selfId, authenticate, createAuditId = randomUUID, enableAuditFaultRestore = false,
  // OPTIONAL SECOND STORE (t55). When provided, the four management routes and the two GET
  // projections operate on THIS handle instead of `store`. It is the PLUGIN's database — the one
  // the QQ-space plugin actually reads (state/qzone-plugin-state.sqlite), whose values are the only
  // ones that decide whether a tool runs.
  //
  // WHY A SEPARATE OPTION AND NOT A REPLACEMENT OF `store`: `store` must keep managing the CONSOLE
  // database, because column-password auditing (createOfflineColumnAuthAudit) and audit-row pruning
  // (pruneOfflineAudit) are bound to it. Retargeting `store` itself would silently move those two
  // into the plugin's database.
  //
  // OMITTING IT IS BYTE-IDENTICAL TO BEFORE: every route falls back to `store`, which is what every
  // existing caller (including src/bridge.js) gets until it opts in.
  pluginStore,
} = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function' ||
      typeof clock !== 'function' || typeof authenticate !== 'function' ||
      typeof createAuditId !== 'function' || typeof selfId !== 'string' || !/^\d{1,20}$/.test(selfId)) {
    throw new TypeError('invalid offline admin router dependencies');
  }
  // `pluginStore` IS TRI-STATE, AND THE THREE STATES MEAN THREE DIFFERENT THINGS:
  //   · `undefined` — the caller never asked for plugin backing. Every route falls back to `store`,
  //     which is byte-identical to the behaviour before this option existed.
  //   · `null` — the caller DID ask, but the plugin database is unavailable (file absent, or it could
  //     not be opened). Every plugin-backed route must then FAIL (`plugin-state-unavailable`) rather
  //     than quietly serve the console database's stale numbers. Falling back here would recreate the
  //     exact bug this work exists to fix: a page that shows `enabled=false` while the plugin runs.
  //   · a handle — a COMPLETE store (`read`+`update`). A read-only one is refused at construction,
  //     because PATCH would otherwise throw mid-transaction instead of failing here.
  if (pluginStore !== undefined && pluginStore !== null &&
      (typeof pluginStore.read !== 'function' || typeof pluginStore.update !== 'function')) {
    throw new TypeError('invalid plugin store for the management routes');
  }
  // The handle every management route, both GET projections AND the management audit rows use.
  //
  // WHY THE AUDIT ROWS FOLLOW THE SAME HANDLE: `/audit` now projects the PLUGIN database, so an
  // intent/outcome pair written to the console database would be INVISIBLE to the operator who just
  // pressed the button — the state would change in one place and its evidence live in another. One
  // handle keeps the row and the change it describes in the same transaction. `handleAuditFaultRestore`
  // is the deliberate exception above: it needs the CONSOLE handle's send authority, and it is
  // disabled by default.
  //
  // Absent (`undefined`) keeps the original behaviour exactly. `null` is NOT absent — it is a
  // configured-but-missing plugin database, and every plugin-backed route must say so.
  const pluginConfigured = pluginStore !== undefined;
  // ⚠️ NOT `pluginStore ?? store`. A NULL pluginStore means "configured but missing", and coalescing it
  // back to `store` would silently serve the console database — the exact substitution this whole
  // change exists to prevent. `management` is therefore NULL in that state, and every route below
  // checks `pluginConfigured` before touching it.
  const management = pluginConfigured ? pluginStore : store;
  /** One shape for every "the plugin database is not there" answer, so callers cannot mistake it
   *  for a data problem or for the console database's contents. */
  const pluginUnavailable = () => response(503, { ok: false, error: 'plugin-state-unavailable' });
  // EXPLICIT BOOLEAN ONLY, AND CONSTRUCTION-TIME ONLY. This is a DESTRUCTURED parameter, so it is
  // read once at construction and — like every other destructured option — it also sees an INHERITED
  // property (e.g. `Object.create({ enableAuditFaultRestore: true })` does enable the path). That is
  // a property of destructuring, not a request-side surface: no body field, query string, header or
  // sessionToken reaches this variable, which is what keeps a fault-clearing route out of reach of a
  // caller. What IS enforced here is the TYPE: `'true'`, `1`, `null` and `{}` are refused rather than
  // coerced, because a coerced truthy value would open a route the host never asked for.
  if (typeof enableAuditFaultRestore !== 'boolean') throw new TypeError('invalid enableAuditFaultRestore');
  const auditFaultRestoreEnabled = enableAuditFaultRestore === true;

  /**
   * `POST /audit/fault/restore` — M10's authenticated entry point for M9.
   *
   * Reached ONLY when the constructor was given `enableAuditFaultRestore: true`, and only AFTER the
   * shared `authenticate` call above has already succeeded: authentication is checked once, before
   * the route table, so an unauthenticated request never gets here and never causes a recovery or a
   * success audit row.
   *
   * WHAT IT DELIBERATELY DOES NOT DO
   * --------------------------------
   * · It does not re-implement recovery. The decision logic, the three-step transaction and the
   *   compare-and-clear all live in `restoreOfflineAuditFault`.
   * · It does not accept an identity from the request. `operator` comes from the authentication
   *   result; `selfId`, `clock` and `createAuditId` come from the construction dependencies. A body
   *   trying to supply operator/source/target/time/auditId is rejected, not ignored.
   * · It does not use `synchronousTransactionStore`. That wrapper exposes only `update` and therefore
   *   carries NO authority, so M9's `requireAuthority` would refuse it. The REAL `store` is passed,
   *   which is the same handle — and therefore the same authority — the write path uses. No registry
   *   entry, no fallback, no bypass is added for this.
   * · It does not turn an M9 refusal into `200 ok:true`. A refusal is a business outcome and gets 409;
   *   a throw is 500. Neither body contains raw state, damaged content or an exception message.
   */
  function handleAuditFaultRestore(method, body, auth) {
    // Method was already constrained by `allowedMethod` (POST only); re-check so this function is safe
    // on its own and cannot be reached with a GET by a future edit.
    if (method !== 'POST') return response(405, { ok: false, error: 'method_not_allowed' });

    // ── body: closed field set, no management identity ────────────────────────────────────
    if (!plain(body) || Object.keys(body).length === 0) {
      return response(400, { ok: false, error: 'invalid_request' });
    }
    if (!isOnlyKeys(body, AUDIT_FAULT_REQUEST_FIELDS)) {
      // An attempt to supply `operator`/`source`/`target`/`time`/`auditId` lands here.
      return response(400, { ok: false, error: 'invalid_request' });
    }
    const { expectedGeneration, expectedLatchRevision } = body;
    // M9 requires a generation: there is no "default" generation to fall back on, and inventing one
    // would make the operator's optimistic lock meaningless.
    if (typeof expectedGeneration !== 'string' || !IDENTIFIER.test(expectedGeneration)) {
      return response(400, { ok: false, error: 'invalid_request' });
    }
    if (expectedLatchRevision !== undefined
        && (!Number.isSafeInteger(expectedLatchRevision) || expectedLatchRevision < 1)) {
      return response(400, { ok: false, error: 'invalid_request' });
    }

    // ── identity from the AUTHENTICATION RESULT, never from the body ──────────────────────
    let actor;
    try {
      actor = makeActor(auth.operator);
    } catch {
      // An unusable clock or audit-id generator is a construction/trust problem, not a request one.
      return response(500, { ok: false, error: 'operation_failed' });
    }

    let outcome;
    try {
      outcome = restoreOfflineAuditFault(store, {
        expectedGeneration,
        ...(expectedLatchRevision === undefined ? {} : { expectedLatchRevision }),
      }, actor);
    } catch {
      // Programmer/commit/audit-write failure: the transaction rolled back, so the fault is RETAINED.
      // Say only that, never why (the message could quote state).
      return response(500, { ok: false, error: 'operation_failed' });
    }

    if (!outcome || typeof outcome !== 'object') {
      return response(500, { ok: false, error: 'operation_failed' });
    }

    if (outcome.ok !== true) {
      // Business refusal. The reason tokens are M9's own closed vocabulary (see `readAuditFault`), and
      // `trail` tells the operator whether a `denied` audit row was written.
      return response(409, {
        ok: false,
        error: 'recovery_refused',
        reason: typeof outcome.reason === 'string' ? outcome.reason : 'unknown',
        trail: outcome.trail === 'recorded' ? 'recorded' : 'not-recorded',
        resolvedGapCount: Number.isSafeInteger(outcome.resolvedGapCount) ? outcome.resolvedGapCount : 0,
      });
    }

    // Success: a minimal projection. No state snapshot, no gap contents, no latch reason text.
    return response(200, {
      ok: true,
      result: 'success',
      resolvedGapCount: Number.isSafeInteger(outcome.resolvedGapCount) ? outcome.resolvedGapCount : 0,
      releasedLatch: outcome.releasedLatch !== null && outcome.releasedLatch !== undefined,
      ...(outcome.latchRetained === undefined || outcome.latchRetained === null
        ? {} : { latchRetained: true }),
    });
  }

  return async function handleOfflineAdminRequest(request) {
    const input = snapshotRequest(request);
    const snapshot = input.request;
    let auth;
    try {
      const authResult = await authenticate(Object.freeze({
        sessionToken: snapshot.sessionToken,
        method: snapshot.method,
        path: snapshot.path,
      }));
      auth = snapshotAuthentication(authResult);
    } catch {
      return response(401, { ok: false, error: 'unauthorized' });
    }
    if (!auth || auth.valid !== true) return response(401, { ok: false, error: 'unauthorized' });

    try {
      if (!input.valid || !isOnlyKeys(snapshot, ['method', 'path', 'body', 'sessionToken']) ||
          typeof snapshot.method !== 'string' || typeof snapshot.path !== 'string' ||
          (snapshot.sessionToken !== undefined && typeof snapshot.sessionToken !== 'string')) {
        return response(400, { ok: false, error: 'invalid_request' });
      }

      const method = snapshot.method;
      const path = snapshot.path;
      const hasBody = snapshot.body !== undefined;
      // THE DEFAULT ROUTE TABLE IS UNCHANGED. `/audit/fault/restore` is appended ONLY when the
      // constructor was given `enableAuditFaultRestore: true`, so a router built without it answers
      // 404 exactly as before — the disabled path is indistinguishable from "this router has no such
      // route", which is the honest answer for a router that cannot do it.
      //
      // WHY AN ARRAY IS BUILT PER REQUEST (terminal review F4): the table used to be consulted
      // directly and the recovery path was a separate earlier `if`. It is now one array, rebuilt on
      // each request from the CONSTRUCTION-TIME `auditFaultRestoreEnabled` constant — nothing here is
      // state, nothing is cached, and the only input is a boolean fixed in the constructor. For a
      // router built WITHOUT the flag the array is the same four entries every time, so the observable
      // behaviour (404 for anything else, 405 for a wrong method) is identical to before; the recovery
      // path simply joins the table when the flag is on, which is why it can no longer be reached by a
      // path that skipped the table.
      const routes = auditFaultRestoreEnabled
        ? ['/status', '/config', '/quota/reset', '/pause/restore', AUDIT_FAULT_RESTORE_PATH]
        : ['/status', '/config', '/quota/reset', '/pause/restore'];
      if (!routes.includes(path)) {
        return response(404, { ok: false, error: 'not_found' });
      }
      const isGetRoute = path === '/status' || path === '/config';
      const routeMethod = isGetRoute ? 'GET' : 'POST';
      // `/config` keeps its GET|PATCH pair. The recovery path is POST-only: it changes state, and a GET
      // that mutates would be reachable from a link.
      const allowedMethod = path === '/config' ? method === 'GET' || method === 'PATCH' : method === routeMethod;
      if (!allowedMethod) return response(405, { ok: false, error: 'method_not_allowed' });

      // ── audit-fault recovery: its own branch, no intent/outcome pair ────────────────────
      // The existing reset/restore flow writes an `unknown` intent row and then a success/unknown
      // outcome row. M9 does NOT work that way: it commits the recovery audit row, the gap resolution
      // and the gate change in ONE transaction and only then does a compare-and-clear on the process
      // latch. Reusing the intent/outcome machinery would split that transaction, which is exactly
      // what §5.2 forbids. So this path bypasses it and calls M9 directly.
      if (path === AUDIT_FAULT_RESTORE_PATH) {
        return handleAuditFaultRestore(method, snapshot.body, auth);
      }

      if (method === 'GET') {
        if (hasBody) return response(400, { ok: false, error: 'invalid_request' });
        if (pluginConfigured && management === null) return pluginUnavailable();
        // READING THE PLUGIN DATABASE CAN LEGITIMATELY FAIL, and the two failures are DIFFERENT
        // problems that an operator must be able to tell apart:
        //   · `plugin-state-incomplete` — the database exists but lacks fields this projection
        //     needs (intervalMinutes / probe / …). The fix is a migration, so the missing names are
        //     returned instead of a generic 500.
        //   · `plugin-busy` — SQLite refused the read because another process holds the write lock.
        //     The fix is a retry, so it must NOT be reported as a data problem.
        // NOTHING IS INVENTED TO AVOID EITHER: no default intervalMinutes, no synthetic probe. A
        // fabricated value would make the console show a configuration the plugin never adopted.
        let projected;
        try {
          projected = qzoneOfflineStatus(management.read(), clock());
        } catch (error) {
          const busy = isBusyError(error);
          if (busy) return response(503, { ok: false, error: 'plugin-busy' });
          return response(503, {
            ok: false, error: 'plugin-state-incomplete', missing: missingStatusFields(management.read()),
          });
        }
        return response(200, { ok: true, ...(path === '/status' ? projected : configProjection(projected)) });
      }

      // Same rule for the four management routes: a configured-but-missing plugin database refuses
      // BEFORE any body parsing, so a malformed body cannot mask the real reason.
      if (pluginConfigured && management === null) return pluginUnavailable();
      const body = snapshot.body;
      let action;
      let reason = '';
      if (path === '/config' && method === 'PATCH') {
        if (!isOnlyKeys(body, CONFIG_FIELDS) || Object.keys(body).length === 0) {
          return response(400, { ok: false, error: 'invalid_request' });
        }
        action = () => configureOfflineQzone(synchronousTransactionStore(management), body, makeActor(auth.operator));
      } else if (path === '/quota/reset') {
        if (!isOnlyKeys(body, ['kind', 'reason']) || !KINDS.has(body.kind) ||
            (Object.hasOwn(body, 'reason') && (typeof body.reason !== 'string' || !REASONS.has(body.reason)))) {
          return response(400, { ok: false, error: 'invalid_request' });
        }
        reason = body.reason ?? '';
        action = (actor) => resetOfflineQuota(synchronousTransactionStore(management, (state) => validateManagementState(state, clock())), body.kind, actor);
      } else if (path === '/pause/restore') {
        if (!isOnlyKeys(body, ['layer', 'reason']) || !LAYERS.has(body.layer) ||
            (Object.hasOwn(body, 'reason') && (typeof body.reason !== 'string' || !REASONS.has(body.reason)))) {
          return response(400, { ok: false, error: 'invalid_request' });
        }
        reason = body.reason ?? '';
        action = (actor) => restoreOfflinePause(synchronousTransactionStore(management, (state) => validateManagementState(state, clock())), body.layer, actor);
      } else {
        return response(400, { ok: false, error: 'invalid_request' });
      }

      let managementIntent = null;
      let managementActors = null;
      if (path === '/quota/reset' || path === '/pause/restore') {
        let state;
        let intentActor;
        try {
          state = management.read();
          if (typeof state?.accessPaused !== 'boolean' || typeof state?.writePaused !== 'boolean') throw new TypeError('invalid pause state');
          const correlationId = createAuditId();
          const intentId = createAuditId();
          const successId = createAuditId();
          const unknownId = createAuditId();
          const ids = [correlationId, intentId, successId, unknownId];
          if (ids.some((id) => !isSafeQzoneAuditId(id)) || new Set(ids).size !== ids.length) {
            throw new TypeError('invalid trusted audit metadata');
          }
          const correlationCheck = formatAuditRecord({
            time: 0, source: 'admin_console', action: 'reset_quota', target: selfId,
            operator: auth.operator, pauseScope: 'none', content: JSON.stringify({ correlationId }), result: 'unknown',
          });
          if (correlationCheck.redacted) throw new TypeError('unsafe correlation id');
          intentActor = makeActor(auth.operator, reason, intentId, correlationId);
          managementActors = {
            successId,
            unknownId,
            correlationId,
          };
        } catch {
          return response(500, { ok: false, error: 'operation_failed' });
        }
        const pauseScope = state.accessPaused ? (state.writePaused ? 'both' : 'access') : (state.writePaused ? 'write' : 'none');
        const selection = path === '/quota/reset' ? body.kind : body.layer;
        try {
          // The gate prevents callbacks that honor the supplied transform from applying after return.
          // It cannot control a malicious store that commits independently or lies about commit timing.
          const appended = appendManagementAudit(management, intentActor.auditId, {
            time: intentActor.time, source: 'admin_console', action: path === '/quota/reset' ? 'reset_quota' : 'restore',
            target: selfId, operator: auth.operator, pauseScope, reason,
            content: JSON.stringify({ selection, phase: 'intent', correlationId: intentActor.correlationId }), result: 'unknown',
          }, intentActor.correlationId, false);
          managementIntent = { action: path === '/quota/reset' ? 'reset_quota' : 'restore', pauseScope, selection,
            intentTime: intentActor.time, outcomeTimeFloor: intentActor.time };
        } catch {
          // An update may have committed before reporting an error. Do not proceed or claim the intent is durable.
          return response(503, { ok: false, error: 'audit-outcome-unknown' });
        }
      }

      try {
        let actionActor;
        if (managementIntent) {
          actionActor = makeActor(auth.operator, reason, managementActors.successId, managementActors.correlationId);
          if (actionActor.time < managementIntent.intentTime) {
            return response(500, { ok: false, error: 'operation-outcome-unknown' });
          }
          managementIntent.outcomeTimeFloor = actionActor.time;
        }
        action(actionActor);
      } catch {
        // A CONFIGURED PLUGIN DATABASE THAT CANNOT SATISFY THE WRITE is a DATA problem, not an
        // internal failure: the operator needs to know to migrate it, not to retry. Distinguishing
        // them here is the difference between "run the migration" and "something is broken".
        if (pluginConfigured) {
          // `management` is the HANDLE; the probe needs the STATE. Reading it here cannot throw in a
          // way that loses the original failure — a throwing read just means "not reportable", and the
          // generic 500 below still answers.
          let missing = null;
          try { missing = missingManagementFields(management.read()); } catch { missing = null; }
          if (missing !== null && missing.length > 0) {
            return response(503, { ok: false, error: 'plugin-state-incomplete', missing });
          }
        }
        if (managementIntent) {
          try {
            const outcomeActor = makeActor(auth.operator, reason,
              managementActors.unknownId, managementActors.correlationId);
            if (outcomeActor.time < managementIntent.outcomeTimeFloor) {
              return response(500, { ok: false, error: 'operation-outcome-unknown' });
            }
            appendManagementAudit(management, outcomeActor.auditId, {
              time: outcomeActor.time, source: 'admin_console', action: managementIntent.action,
              target: selfId, operator: auth.operator, pauseScope: managementIntent.pauseScope, reason,
              content: JSON.stringify({ selection: managementIntent.selection, phase: 'outcome', correlationId: outcomeActor.correlationId }), result: 'unknown',
            }, outcomeActor.correlationId, true);
          } catch { /* the durable outcome record may be unavailable */ }
          return response(500, { ok: false, error: 'operation-outcome-unknown' });
        }
        throw new Error('operation failed');
      }
      return response(200, { ok: true });
    } catch {
      return response(500, { ok: false, error: 'operation_failed' });
    }
  };

  function makeActor(operator, reason = '', auditId = createAuditId(), correlationId) {
    const time = clock();
    if (!Number.isFinite(time) || typeof auditId !== 'string' || !IDENTIFIER.test(auditId) ||
        (correlationId !== undefined && (typeof correlationId !== 'string' || !IDENTIFIER.test(correlationId)))) {
      throw new TypeError('invalid trusted audit metadata');
    }
    return { operator, source: 'admin_console', target: selfId, time, auditId, reason, ...(correlationId ? { correlationId } : {}) };
  }
}

function appendManagementAudit(store, id, input, correlationId, allowExistingCorrelation) {
  let appended = false;
  const record = formatAuditRecord(input);
  synchronousTransactionStore(store).update((state) => {
    if (!Array.isArray(state.audit)) throw new TypeError('invalid audit state');
    if (!allowExistingCorrelation && state.audit.some((entry) => {
      try { return JSON.parse(entry?.record?.content ?? 'null')?.correlationId === correlationId; } catch { return false; }
    })) throw new Error('duplicate correlation id');
    if (state.audit.some((entry) => entry.id === id)) throw new Error('duplicate audit id');
    appended = true;
    return { ...state, audit: [...state.audit, { id, record }] };
  });
  return { appended };
}
