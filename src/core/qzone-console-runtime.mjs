import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { openOfflineStore } from './qzone-store-offline.mjs';
import { createQzoneConsoleGateway } from './qzone-console-gateway.mjs';
import { beijingDay } from './qzone-policy-offline.mjs';
import { pruneOfflineAudit } from './qzone-audit-offline.mjs';
import { createAuditJsonl } from './qzone-audit-jsonl-offline.mjs';

// ── AUDIT-CLEANUP VISIBILITY: closed vocabularies ───────────────────────────────────────────
//
// WHY A CLOSED SET AND NOT `error.code` / `error.message` VERBATIM: this status object is meant to be
// returned to an operator (and eventually a console response). An exception message can quote a file
// path, a credential or an audit body, and an arbitrary `error.code` is a string this module does not
// control. So every failure is mapped onto one of the tokens below, and nothing else is exposed.
//
// MEASURED BASELINE (before this change, real temp SQLite, importing this module):
//   · database side, `state.audit` not an array -> the runtime construction THREW (`invalid audit state`)
//   · files side, directory unusable           -> silently swallowed, nothing observable
//   · `schedule()` throwing on the first call  -> the runtime construction THREW
//   · a healthy runtime exposed exactly `['close','handle','selfId']` — no cleanup status at all
// The first two of those are why "did it fail?" could not be answered by a caller.
const CLEANUP_STATE = Object.freeze({
  // `idle` is the RECORDS' initial value only. Both prunes run inside the factory before the handle
  // is returned, so `auditCleanupStatus()` never reports `idle` — see its docblock.
  disabled: 'disabled', idle: 'idle', ok: 'ok', failed: 'failed',
});
const CLEANUP_CODE = Object.freeze({
  /** `state.audit` is not an array — nothing can be pruned until the state is repaired. */
  auditStateInvalid: 'audit-state-invalid',
  /** The store transaction itself failed (I/O, commit, lock). */
  storeUpdateFailed: 'store-update-failed',
  /** Caller has no permission on the audit directory or one of its files. */
  permissionDenied: 'permission-denied',
  /** The configured path exists but is not a directory. */
  notADirectory: 'not-a-directory',
  /** The path or file is held by another process (Windows). */
  busy: 'busy',
  /** No space left on the device. */
  noSpace: 'no-space',
  /** Read-only filesystem. */
  readOnlyFilesystem: 'read-only-filesystem',
  /** Any other filesystem failure, deliberately un-detailed. */
  ioError: 'io-error',
  /** The prune returned a report this module cannot interpret — NOT counted as success. */
  unexpectedReport: 'unexpected-report',
  /** A non-Error throw, or a failure that fits nothing above. */
  unexpected: 'unexpected',
  /** `now()` did not produce a finite timestamp, so the attempt could not even be stamped. */
  clockInvalid: 'clock-invalid',
  /** `schedule(...)` threw: the day-cut is NOT arranged. */
  scheduleThrew: 'schedule-threw',
  /** The runtime was closed; its timer is cancelled on purpose. */
  closed: 'closed',
});
const SCHEDULE_STATE = Object.freeze({ scheduled: 'scheduled', stopped: 'stopped' });
/**
 * The largest millisecond value a `Date` can represent (`8.64e15`).
 *
 * ⚠️ DO NOT compare a raw clock value against this on its own. Every consumer here first shifts the
 * timestamp by the BEIJING OFFSET (`beijingDay` does `new Date(timestamp + OFFSET_MS)`), so the
 * usable upper bound for a raw clock value is `MAX_DATE_MS - OFFSET_MS`, NOT `MAX_DATE_MS`. A guard
 * using `Math.abs(value) <= MAX_DATE_MS` therefore accepts the `(MAX - 8h, MAX]` sliver, where
 * `beijingDay` throws `RangeError` — and that throw happened INSIDE both prunes, so a perfectly
 * healthy database and disk were reported as `store-update-failed` / `io-error` (t37, measured with
 * `MAX` and `MAX - 8h + 1`). `readClock` applies the shift; keep it that way.
 *
 * The negative side needs no extra margin: `-MAX_DATE_MS + OFFSET_MS` is still inside the range, so
 * the same shifted test accepts it (measured).
 */
const MAX_DATE_MS = 8.64e15;
/** The Beijing offset `beijingDay` adds before constructing its Date. Mirrors `qzone-policy-offline`. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Classify a database-side prune failure WITHOUT quoting the exception.
 *
 * Structural, not message-matching: after the failure the state is read once and asked whether
 * `audit` is usable. That distinguishes "the audit array is broken" (unrepairable here) from "the
 * transaction failed" (retryable) without depending on another module's error text.
 */
function databaseFailureCode(store) {
  try {
    if (!Array.isArray(store.read().audit)) return CLEANUP_CODE.auditStateInvalid;
  } catch { /* the store itself is unreadable: fall through to the transaction verdict */ }
  return CLEANUP_CODE.storeUpdateFailed;
}

/** Classify a files-side prune failure from `error.code` alone (a closed allowlist). */
function filesFailureCode(error) {
  // A throw that is not an Error object carries no `code` we can trust (a thrown string, `null`,
  // a bare object). It fits none of the filesystem categories below, so it gets its own token
  // instead of being reported as an I/O error we cannot actually attribute.
  //
  // REACHABILITY, stated accurately (t37): this branch is UNREACHABLE in the current implementation.
  // It used to be reachable through the caller's clock — the sink called the caller's `now` inside
  // `prune()`, so a hostile clock could throw a non-Error from there. Since the single-read fix
  // (t36/F1) the sink's `clock` is `() => filesStamp`, a pure pass-through that cannot throw, and
  // `fs` always throws `Error` instances. It is kept as DEFENCE against `fs` behaviour changing (a
  // non-Error from a future Node/libuv path), and it is deliberately not unit-tested: fighting the
  // sink to reach it would mean re-introducing the very seam the single-read fix removed.
  if (!(error instanceof Error)) return CLEANUP_CODE.unexpected;
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === 'EACCES' || code === 'EPERM') return CLEANUP_CODE.permissionDenied;
  if (code === 'ENOTDIR') return CLEANUP_CODE.notADirectory;
  if (code === 'EBUSY') return CLEANUP_CODE.busy;
  if (code === 'ENOSPC') return CLEANUP_CODE.noSpace;
  if (code === 'EROFS') return CLEANUP_CODE.readOnlyFilesystem;
  return CLEANUP_CODE.ioError;
}

/**
 * THE TWO REAL INTERPRETERS — the shipped answer-readers, exported so tests drive THESE.
 *
 * WHY THEY ARE EXPORTED (terminal review F1, measured): the tests used to restate this logic as an
 * inline lambda with a comment claiming it was "the REAL interpreter semantics". It was not — it was a
 * second copy. A mutation that made the SHIPPED interpreter never return `null` left all three suites
 * green (26/9/39), because the only thing pinned was "what the kernel does when it is handed null",
 * never "whether the code that ships can produce null at all". Two copies can drift; one cannot. So
 * the decision-kernel tests import these and no lambda is restated in the test file.
 *
 * They are PURE: no I/O, no clock, no state. `null` means "this report shape is not readable"; it is
 * one of several ways an attempt can fail, because the kernel also rejects any non-count (see
 * `applyCleanupOutcome`), so a missed `return` here still cannot be laundered into a success.
 */

/** `pruneOfflineAudit` returns `{ removed: <count> }`; anything else is `null` (unreadable). */
export function interpretDatabaseReport(report) {
  if (!report || typeof report !== 'object') return null;
  const { removed } = report;
  return Number.isSafeInteger(removed) && removed >= 0 ? removed : null;
}

/** `createAuditJsonl().prune()` returns `{ removed: string[], kept: number }`; anything else is `null`. */
export function interpretFilesReport(report) {
  if (!report || typeof report !== 'object') return null;
  const { removed, kept } = report;
  if (!Array.isArray(removed) || !Number.isSafeInteger(kept) || kept < 0) return null;
  return removed.length;
}

/** Frozen bundle of the real interpreters (convenience for callers/tests; adding a key is explicit). */
export const cleanupInterpreters = Object.freeze({
  database: interpretDatabaseReport,
  files: interpretFilesReport,
});

/**
 * THE DECISION KERNEL for one cleanup attempt — pure, exported, and the ONLY place that decides
 * what an attempt means.
 *
 * WHY IT IS EXPORTED: the branch it contains ("the prune returned a shape we cannot read ⇒ failed")
 * is the whole point of this module — it is what separates "read the answer" from "only caught the
 * exception". Measured before this extraction: deleting that branch left all suites green, i.e. the
 * honesty claim had NO test that could tell the branch existed. Extracting the kernel makes the
 * decision observable from a plain function call, with no injection seam, no test-only switch and
 * no exported mutable state: the caller just hands in a `report` and an `interpret`.
 *
 * THE VERDICT IS ON THE VALUE, NOT ON ONE SENTINEL (terminal review F2, measured). An earlier
 * revision compared `removed === null` only, so an interpreter that returned `undefined` — the exact
 * shape a forgotten `return` produces — `-1`, `'3'`, `NaN`, `1.5` or `{}` was recorded as SUCCESS with
 * that garbage in `lastRemoved`. The rule is now: a successful attempt must yield a genuine
 * non-negative integer count. Anything else is `failed`/`unexpected-report`. `null` remains a
 * supported way for an interpreter to SAY "shape unreadable"; it is no longer the only way to fail.
 *
 * MERGE SEMANTICS (and why `undefined` means DELETE):
 *   · a key with a value  -> set it on the side record
 *   · a key with `undefined` -> REMOVE it (that is how a stale `code` is cleared on success)
 * The returned object is frozen and the arguments are never mutated.
 *
 * @param stamp   - the attempt's timestamp, or anything non-finite when the clock is unusable.
 * @param report  - whatever `work()` returned (only meaningful when `threw` is false).
 * @param threw   - true when `work()` threw; `failureCode` then names the category.
 * @param interpret - `(report) => count | null`. A count must be a non-negative safe integer.
 * @param failureCode - closed-set token describing the throw (defaults to `unexpected`).
 * @returns the fields to merge onto the side record.
 */
export function applyCleanupOutcome({ stamp, report, threw = false, interpret, failureCode = CLEANUP_CODE.unexpected } = {}) {
  if (!Number.isFinite(stamp)) {
    // The attempt cannot even be dated: report failure and do NOT claim an attempt time.
    return Object.freeze({ state: CLEANUP_STATE.failed, code: CLEANUP_CODE.clockInvalid });
  }
  if (threw === true) {
    // A throw never touches `lastSuccessAt`: the last time this side actually worked stays visible.
    return Object.freeze({
      state: CLEANUP_STATE.failed,
      code: typeof failureCode === 'string' && failureCode ? failureCode : CLEANUP_CODE.unexpected,
      lastAttemptAt: stamp,
    });
  }
  if (typeof interpret !== 'function') throw new TypeError('interpret must be a function');
  const removed = interpret(report);
  // THE HONESTY RULE — closed on the VALUE, not on `null`:
  //   · `undefined` (a missing `return`), `-1`, `'3'`, `NaN`, `1.5`, `{}` — are all NOT counts;
  //   · `0` and any positive safe integer ARE counts (a prune that removed nothing still succeeded).
  // Recording garbage in `lastRemoved` would be a success report nobody can act on, so anything that
  // is not a non-negative safe integer is a failure carrying the same closed-set code.
  if (!Number.isSafeInteger(removed) || removed < 0) {
    return Object.freeze({
      state: CLEANUP_STATE.failed, code: CLEANUP_CODE.unexpectedReport, lastAttemptAt: stamp,
    });
  }
  return Object.freeze({
    state: CLEANUP_STATE.ok,
    code: undefined,                 // delete: success must not leave a stale failure code behind
    lastAttemptAt: stamp,
    lastSuccessAt: stamp,
    lastRemoved: removed,
  });
}

/** Apply a kernel result to a side record. `undefined` deletes the key (see `applyCleanupOutcome`). */
function mergeSide(side, outcome) {
  for (const [key, value] of Object.entries(outcome)) {
    if (value === undefined) delete side[key];
    else side[key] = value;
  }
}

/**
 * Deep-frozen, freshly built copy of one side's status. Built per call so a caller can never reach —
 * or mutate — the live record. Pure: no clock, no I/O, no retry.
 */
function projectSide(side) {
  return Object.freeze({
    state: side.state,
    ...(side.code === undefined ? {} : { code: side.code }),
    ...(side.lastAttemptAt === undefined ? {} : { lastAttemptAt: side.lastAttemptAt }),
    ...(side.lastSuccessAt === undefined ? {} : { lastSuccessAt: side.lastSuccessAt }),
    ...(side.lastRemoved === undefined ? {} : { lastRemoved: side.lastRemoved }),
  });
}

// The caller must authenticate getIdentity and bind it to the active SnowLuma
// connection. This runtime manages console state only; it sends no QQ actions.
export async function openQzoneConsoleRuntime({ stateDir, consoleToken, getIdentity, authorizeConsole, verifyCsrf, isAgentPaused,
  auditJsonlDir, now = Date.now, schedule = setTimeout, cancelSchedule = clearTimeout,
  enableAuditFaultRestore = false, operationApprovals,
  // OPTIONAL PLUGIN DATABASE (t55). A path to the QQ-space plugin's own SQLite file
  // (`state/qzone-plugin-state.sqlite`). When supplied and the file EXISTS, this runtime opens it and
  // hands it to the gateway so /status, /config and /audit project what the plugin actually uses —
  // and so PATCH /config, /quota/reset and /pause/restore change it.
  //
  // WHY `openOfflineStore` AND NOT A READ-ONLY HANDLE: the three management routes need `update`. The
  // split is deliberate — `store` (the console database) keeps backing audit pruning and
  // column-password auditing, which must not move into the plugin's file.
  //
  // WHY THE FILE-EXISTS CHECK: `openOfflineStore` creates the file when it is absent (`wx`). A console
  // must never conjure a plugin database into existence — that would show an empty-but-valid space
  // configuration the plugin has never adopted. Absent file ⇒ `pluginStore` stays null and the routes
  // answer `plugin-state-unavailable`.
  pluginStatePath } = {}) {
  // CONSTRUCTION-TIME OPT-IN, EXPLICIT BOOLEAN ONLY, DEFAULT false.
  //
  // This flag only decides whether the gateway's `/audit/fault/restore` route EXISTS. It is read here
  // and forwarded verbatim; nothing from a request can reach it, and a non-boolean is refused rather
  // than coerced (a truthy `'false'` would open a fault-clearing route nobody asked for). Omitting it
  // — what src/bridge.js and every other existing caller does — leaves behaviour byte-identical.
  //
  // It is NOT derived from any other option (not from stateDir, not from auditJsonlDir): an option
  // that can clear a write fault must be passed on purpose.
  if (typeof enableAuditFaultRestore !== 'boolean') throw new TypeError('invalid enableAuditFaultRestore');
  // OPTIONAL and NO DEFAULT. Omitting it means "this runtime prunes no audit FILES", which is what
  // every existing caller (including src/bridge.js) gets — so the default activation is unchanged.
  // It is NOT derived from stateDir on purpose: silently adding file deletion to a caller that never
  // asked for it would change production behaviour behind an option that was never passed.
  //
  // Task card §7 asks for BOTH storages to be pruned ("启动时和每天零点清理过期审计文件"), and the two
  // are independent by design: this one deletes day files, pruneOfflineAudit deletes store rows, and
  // neither may delete the other's data. A relative path is refused for the same reason
  // createAuditJsonl refuses one: the target would silently depend on the process CWD.
  if (auditJsonlDir !== undefined && (typeof auditJsonlDir !== 'string' || !auditJsonlDir || !isAbsolute(auditJsonlDir))) {
    throw new TypeError('auditJsonlDir must be an absolute path when provided');
  }
  // OPTIONAL FACTORY, NO DEFAULT, FAIL-CLOSED. Omitting it means "this console has no approval
  // source": the broker is never built, the option is never forwarded, and the gateway's
  // `/operation-approvals` route stays absent (a 404 from the admin router), which is exactly what
  // every existing caller — including src/bridge.js — observed before this option existed.
  //
  // WHY A FACTORY AND NOT A READY BROKER: the broker needs the store this function itself opens
  // (for the decision audit) and the same `clock` the rest of the runtime uses. Handing the caller a
  // store it cannot yet reach would invite a second handle on the same file. So the caller supplies
  // "how to build one", called once, below, after the store is open.
  //
  // A NON-FUNCTION IS REFUSED RATHER THAN IGNORED: silently dropping `operationApprovals: broker`
  // (the shape someone would naturally try) would produce a console that LOOKS approval-capable in
  // the config and answers 404 on the route — a fake "wired" state. `null` is refused too: "no
  // approvals" is spelled by omitting the option, not by passing a truthy-looking nothing.
  if (operationApprovals !== undefined && typeof operationApprovals !== 'function') {
    throw new TypeError('invalid operationApprovals');
  }
  if (typeof stateDir !== 'string' || !stateDir || !((typeof consoleToken === 'string' && consoleToken) || typeof consoleToken === 'function') ||
      typeof getIdentity !== 'function' || typeof authorizeConsole !== 'function' || typeof verifyCsrf !== 'function' ||
      typeof isAgentPaused !== 'function' || typeof now !== 'function' || typeof schedule !== 'function' || typeof cancelSchedule !== 'function') throw new TypeError('invalid runtime dependencies');
  // ABSOLUTE OR ABSENT. A relative plugin path would silently resolve against the process CWD, which
  // is how a console ends up reading a DIFFERENT database than the plugin — the exact split this
  // option exists to close. Same rule `auditJsonlDir` already follows.
  if (pluginStatePath !== undefined &&
      (typeof pluginStatePath !== 'string' || !pluginStatePath || !isAbsolute(pluginStatePath))) {
    throw new TypeError('pluginStatePath must be an absolute path when provided');
  }
  const filename = join(stateDir, 'qzone-console-state.sqlite');
  // Refuse links before opening or pruning the database. This check does not
  // defend against another local process replacing the file concurrently.
  try {
    const stat = lstatSync(filename);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('invalid-state-file');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let identity = null;
  if (!existsSync(filename)) {
    identity = await getIdentity();
    if (typeof identity !== 'string' || !/^[1-9]\d{0,19}$/.test(identity)) throw new Error('identity-unavailable');
  } else {
    // Existing local management state remains accessible while the gateway is
    // offline, but an explicitly different online account must not inherit it.
    try { identity = await getIdentity(); } catch { identity = null; }
    if (identity !== null && (typeof identity !== 'string' || !/^[1-9]\d{0,19}$/.test(identity))) throw new Error('identity-unavailable');
  }
  const initialDay = beijingDay(now());
  const initial = { botQq: identity, selfId: identity, enabled: false, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, pauseCycles: { access: null, write: null }, reads: 0, writes: 0, probe: 'done',
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 }, intervalMinutes: 100, activeStart: 420, activeEnd: 1380,
    ledger: { day: initialDay, used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    lastPostAt: null, commentTargets: [], likes: [], outcomes: {}, dispatchClaims: {}, notices: [],
    readAttempts: {}, readOutcomes: {}, browseDay: initialDay, todayBrowses: 0,
    lastBrowseAt: null, usedOpportunities: {}, audit: [] };
  const store = openOfflineStore(filename, initial);
  // Declared OUTSIDE the try so the construction-failure path below can release it too: a factory
  // may have handed back a live broker just before something else rejected the construction, and
  // that broker must not outlive the runtime that never got returned.
  let operationApprovalsBroker;
  // THE PLUGIN DATABASE, OPENED LAZILY AND ONLY IF IT ALREADY EXISTS.
  //
  // `openOfflineStore` opens with `wx` and would CREATE the file. A console must never do that: it
  // would show a fabricated-but-valid space configuration the plugin never adopted, and the plugin
  // would then read it as real. So the existence check comes first and a missing file is a NORMAL
  // state (`pluginStore: null`), not an error — the plugin simply has never run on this machine.
  //
  // A failure to open an EXISTING file is also contained: the console keeps working (its own database
  // is fine) and every plugin-backed route answers `plugin-state-unavailable` instead of pretending.
  // TRI-STATE, MATCHING THE GATEWAY AND ROUTER CONTRACT:
  //   · `pluginStatePath === undefined` ⇒ `pluginStore` stays UNDEFINED ("not asked for"): every route
  //     keeps using the console database, byte-identical to before this option existed.
  //   · configured but the file is absent / unopenable ⇒ `pluginStore = null` ("asked for, missing"):
  //     every plugin-backed route answers `plugin-state-unavailable` instead of serving stale console
  //     numbers. Collapsing this to `undefined` would silently recreate the bug being fixed.
  let pluginStore = pluginStatePath === undefined ? undefined : null;
  if (pluginStatePath !== undefined && existsSync(pluginStatePath)) {
    try {
      // The `initial` argument is IGNORED for an existing file (`openOfflineStore` only inserts it on
      // creation), so passing the console's own seed here cannot overwrite plugin data. It is passed
      // because the signature requires one; the shape below is only ever used for a file that, by the
      // `existsSync` above, does not exist at this point in this branch.
      pluginStore = openOfflineStore(pluginStatePath, initial);
    } catch {
      pluginStore = null;
    }
  }
  try {
    const selfId = store.read().botQq;
    if (typeof selfId !== 'string' || !/^[1-9]\d{0,19}$/.test(selfId)) throw new Error('identity-unavailable');
    if (identity && identity !== selfId) throw new Error('identity-mismatch');
    // TWO STORAGES, TWO PRUNES, NEITHER TOUCHING THE OTHER'S DATA (task card §7).
    // The file-side sink is built here only when the caller supplied a directory.
    //
    // `filesStamp` is the ONE stamp the next files-side prune is allowed to use. The sink's own
    // `clock()` is a PASS-THROUGH to it rather than a second call to the caller's `now` (t36/F1):
    // `prune()` reads `clock()` internally, and reading the caller's clock twice meant a clock that
    // threw only on the second read failed INSIDE `prune()`, where nothing but a filesystem code is
    // available — so a healthy disk was reported as `io-error`/`permission-denied`. There is still
    // exactly one caller-clock read per attempt; the sink simply reuses it.
    let filesStamp;
    const auditFiles = auditJsonlDir === undefined
      ? null
      : createAuditJsonl({ root: auditJsonlDir, clock: () => filesStamp });

    // ── PROCESS-LOCAL CLEANUP STATE ───────────────────────────────────────────────────────────
    //
    // Ordinary mutable records, read by `auditCleanupStatus()` through `projectSide` (a frozen copy
    // per call). Nothing here is persisted and nothing is added to the store: this is diagnostic
    // state for THIS process, and a restart starts from `idle`/`disabled` again.
    //
    // `lastSuccessAt` is a SEPARATE field from `lastAttemptAt` on purpose: a later failure must not
    // erase the last time the prune actually worked, otherwise an operator cannot tell "it has been
    // broken for 5 minutes" from "it has never worked".
    const cleanup = {
      database: { state: CLEANUP_STATE.idle },
      files: { state: auditFiles === null ? CLEANUP_STATE.disabled : CLEANUP_STATE.idle },
      schedule: { state: SCHEDULE_STATE.stopped },
    };

    /**
     * One attempt, one side. `work` must RETURN a report; a throw is a failure.
     *
     * FAILURE IS NOT SILENT AND PARTIAL SUCCESS IS NOT SUCCESS: the decision itself lives in
     * `applyCleanupOutcome` (exported, pure, unit-tested), so the branch that treats an unreadable
     * report as `failed`/`unexpected-report` is covered by a test instead of only by review. This
     * wrapper just runs the work and merges the verdict.
     *
     * F5 (terminal review): the kernel call is INSIDE a try as well. `interpret` is a shipped pure
     * function today and cannot throw — but this wrapper is also reached from the DAY-CUT TIMER
     * callback, where an escaping exception would become an uncaught error in someone else's event
     * loop. A defensive guard costs one branch and keeps that impossible. A throw from the kernel is
     * recorded as a failure of THIS side; it never escapes into the timer.
     */
    const recordAttempt = (side, at, work, interpret, failureCode) => {
      let report;
      let threw = false;
      let code = CLEANUP_CODE.unexpected;
      if (Number.isFinite(at)) {
        // The work is only attempted with a usable clock; `applyCleanupOutcome` owns the verdict.
        try {
          report = work();
        } catch (error) {
          threw = true;
          code = failureCode(error);
        }
      }
      let outcome;
      try {
        outcome = applyCleanupOutcome({ stamp: at, report, threw, interpret, failureCode: code });
      } catch {
        // Defence in depth (see F5 above): a kernel/interpret throw is this side's failure, not an
        // uncaught error in the timer callback.
        outcome = Object.freeze({
          state: CLEANUP_STATE.failed, code: CLEANUP_CODE.unexpected,
          ...(Number.isFinite(at) ? { lastAttemptAt: at } : {}),
        });
      }
      mergeSide(side, outcome);
    };

    // The interpreters themselves are the MODULE-LEVEL exports (`interpretDatabaseReport` /
    // `interpretFilesReport`) — there is deliberately no second copy here, so the tests that drive
    // the kernel and the code that ships cannot drift apart (terminal review F1).

    /**
     * Read the clock ONCE, treating a THROW exactly like a non-finite value.
     *
     * WHY (Codex reproduction, measured): `now()` was called OUTSIDE `recordAttempt` for the attempt
     * stamp, so a clock that THROWS blew straight through this wrapper — and when that happened
     * inside the day-cut timer callback the exception escaped into the host event loop, the re-arm
     * line never ran, and `schedule` kept reporting `scheduled` for a timer that no longer existed.
     * The same clock that RETURNS a non-finite value was already handled (the kernel's stamp branch
     * yields `failed`/`clock-invalid`, pinned by RT-CL-9d) — so the two paths are merged here rather
     * than given a second verdict of their own: an unusable clock is simply "no stamp", and the
     * kernel decides.
     *
     * RANGE, NOT JUST FINITENESS (t36/F4, measured): a finite value outside `Date`'s representable
     * range (e.g. `8.64e15 + 1`) sailed through this guard and then exploded inside `beijingDay` —
     * i.e. INSIDE both prunes — where it was classified as `store-update-failed` / `io-error`. The
     * database and the disk were perfectly healthy; only the clock was broken. A timestamp that
     * cannot be turned into a `Date` is not a usable stamp, so it is rejected HERE, where the verdict
     * is still `clock-invalid`.
     *
     * THE SHIFT IS PART OF THE RANGE (t37, measured). `beijingDay` constructs its Date from
     * `timestamp + 8h`, so the USABLE upper bound for a raw clock value is `MAX - 8h`, not `MAX`.
     * Guarding with `Math.abs(value) <= MAX` left a 28 800 000 ms sliver `(MAX - 8h, MAX]` where this
     * function said "usable" and `beijingDay` threw `RangeError` — inside the prunes again, so the
     * same lie came back wearing the same codes (`MAX` and `MAX - 8h + 1` both reproduced it). The
     * test is therefore applied to the SHIFTED value, which rejects that sliver while still accepting
     * the legitimate boundary (`MAX - 8h` → ok) and the negative extreme (`-MAX` → ok).
     *
     * @returns a timestamp that is finite AND representable as a Date after the Beijing shift, else
     *   `undefined`.
     */
    const readClock = () => {
      try {
        const value = now();
        if (!Number.isFinite(value)) return undefined;
        // Judge the value the CONSUMERS will build their Date from, not the raw one.
        return Math.abs(value + BEIJING_OFFSET_MS) <= MAX_DATE_MS ? value : undefined;
      } catch {
        return undefined;
      }
    };

    const pruneDatabase = () => {
      // ONE read: the same stamp dates the attempt and drives the prune, so the attempt cannot be
      // dated by one clock result while the work used another.
      const at = readClock();
      recordAttempt(cleanup.database, at,
        () => pruneOfflineAudit(store, at),
        interpretDatabaseReport,
        () => databaseFailureCode(store));
    };

    const pruneFiles = () => {
      if (auditFiles === null) return;   // disabled: the filesystem is never touched
      // ONE read of the CALLER's clock, for the same reason the database side has one: `prune()`
      // reads its own `clock()` internally, so that clock is made a PASS-THROUGH of this stamp
      // instead of a second trip to `now` (see `filesStamp` where the sink is built).
      //
      // THIS IS WHAT REMOVES THE "CLOSED-SET CODE LIE" (t36/F1, measured). Previously a clock that
      // threw only on the SECOND read failed inside `prune()`, where the only vocabulary available is
      // filesystem codes — so a healthy disk with a broken clock was reported as `io-error`,
      // `permission-denied` or `unexpected`. Now the caller's clock is read exactly once; if it is
      // unusable the prune is never called at all (the kernel's stamp branch refuses first), and the
      // verdict is `clock-invalid` — the honest one.
      const at = readClock();
      filesStamp = at;
      recordAttempt(cleanup.files, at, () => auditFiles.prune(), interpretFilesReport, filesFailureCode);
    };

    // STARTUP PRUNE. A failure here is RECORDED, not thrown: `database.state`/`files.state` carry the
    // verdict and the closed-set code, which is strictly more visible than the old behaviour (the
    // database side used to abort construction with an exception whose message was all a caller got,
    // and the files side was swallowed entirely). Availability is unchanged in the direction that
    // matters: nothing that used to run is skipped, and no new retry/timer is added.
    pruneDatabase();
    pruneFiles();

    // THE APPROVAL SOURCE, BUILT HERE AND ONLY HERE. The factory runs AFTER the store is open (the
    // broker needs it to audit decisions) and BEFORE the gateway is constructed (the gateway checks
    // `listPending`/`decide` at construction and 404s the route without them). It is called exactly
    // once, with the SAME two dependencies the rest of this file uses.
    //
    // NOTHING IS SWALLOWED. A factory that throws propagates, and a factory that returns something
    // the gateway refuses (`invalid operation approvals`) also propagates out of this function. The
    // alternative — catching and continuing without approvals — would return a runtime whose console
    // silently answers 404 on a route the caller explicitly asked for, i.e. a "wired" state that is
    // not wired. A caller that cannot have its approval source must not get a console at all.
    //
    // The handle's `close()` below closes the broker too (pending tickets are released, not leaked).
    operationApprovalsBroker = operationApprovals === undefined
      ? undefined
      : operationApprovals({ store, clock: now });

    // Deliberately omit isDispatchAvailable until authenticated production
    // wiring exists; the gateway then reports false instead of a fake ready state.
    // `enableAuditFaultRestore` is NOT a dispatch option and must never influence the reported
    // `dispatchAvailable` value: it only adds a management recovery route.
    // `operationApprovalsBroker` is likewise NOT a dispatch option: it adds the operator decision
    // route only, and `dispatchAvailable` stays false either way.
    const handle = createQzoneConsoleGateway({ store, stateDir, selfId, consoleToken,
      authorizeConsole, verifyCsrf, isAgentPaused, now, enableAuditFaultRestore,
      operationApprovals: operationApprovalsBroker, pluginStore });
    let timer;
    let closed = false;
    const scheduleCleanup = () => {
      // The clock is read through the SAME guard the prune uses, so a clock that THROWS here is not
      // a special case: it is an unusable clock, exactly like one returning `NaN`.
      const current = readClock();
      // An unusable CLOCK is a programming/trust error, not a cleanup failure: it must keep failing
      // loudly, otherwise the day-cut silently drifts onto a garbage delay. The schedule record is
      // still made honest first — `stopped` + a closed-set code, never a stale `scheduled`.
      if (current === undefined) {
        cleanup.schedule.state = SCHEDULE_STATE.stopped;
        cleanup.schedule.code = CLEANUP_CODE.clockInvalid;
        throw new TypeError('invalid clock');
      }
      const dayMs = 86400000;
      const shifted = current + 8 * 3600000;
      const delay = dayMs - ((shifted % dayMs) + dayMs) % dayMs;
      try {
        timer = schedule(() => {
          if (closed) return;
          // ── THE DAY-CUT BODY IS FULLY CONTAINED ─────────────────────────────────────────────
          // NOTHING inside this callback may escape. Measured escape (Codex): a throwing clock made
          // `pruneDatabase()` throw, so the re-arm below never ran — the one-shot timer was already
          // consumed, yet `schedule` still said `scheduled` and the host event loop received an
          // uncaught error. The prunes are contained at their own level (`readClock` + the kernel),
          // and this wrapper is the backstop for everything else.
          let rearmed = false;
          try {
            pruneDatabase();
            pruneFiles();
            scheduleCleanup();
            rearmed = true;
          } catch {
            // Deliberately no message: the status fields carry the closed-set verdict.
          }
          if (!rearmed) {
            // BACKSTOP — THIS BLOCK IS LOAD-BEARING AND IS DRIVEN BY A TEST (RT-CL-11c).
            //
            // It is reached when the re-arm fails for a reason OTHER than an unusable clock, and the
            // reachable example is a caller-supplied `schedule` whose handle THROWS from `unref()`.
            // `scheduleCleanup` has, by then, already set `scheduled` and deleted the code (it only
            // discovers the problem when it unrefs), so `rearmed` stays false and NOTHING ELSE will
            // ever correct the status: deleting this block is precisely the "fake scheduled" state
            // this module exists to prevent, and RT-CL-11c turns red. (Earlier revisions of this
            // comment claimed reaching it "would need an injection seam" — that was wrong: the public
            // `schedule` option is enough. The default `setTimeout` handle does not throw, so a
            // production wiring that passes the default never takes this path.)
            if (cleanup.schedule.state !== SCHEDULE_STATE.stopped) {
              cleanup.schedule.state = SCHEDULE_STATE.stopped;
              cleanup.schedule.code = CLEANUP_CODE.scheduleThrew;
            } else if (cleanup.schedule.code === undefined) {
              cleanup.schedule.code = CLEANUP_CODE.scheduleThrew;
            }
          }
        }, delay);
      } catch {
        // The day-cut is NOT arranged. Recorded so an operator sees `stopped`/`schedule-threw`
        // instead of a status that keeps claiming a timer exists.
        cleanup.schedule.state = SCHEDULE_STATE.stopped;
        cleanup.schedule.code = CLEANUP_CODE.scheduleThrew;
        return;
      }
      cleanup.schedule.state = SCHEDULE_STATE.scheduled;
      delete cleanup.schedule.code;
      // `unref` IS GUARDED (t36/F3, measured). It used to sit outside every try, so a handle whose
      // `unref()` throws left a LIVE timer behind while the constructor rejected — measured
      // `{timersCreated:1, cancelCalls:0, rejected:true, timerLeaked:true}` — contradicting the
      // "a rejected construction leaves no timer" invariant RT-CL-10c asserts for the clock path.
      // The handle is cancelled here before the error propagates, and the error STILL propagates so
      // the caller learns the arrangement is not trustworthy. In the day-cut path this throw is
      // caught by the callback's own guard, which is what makes the backstop above fire.
      try {
        timer?.unref?.();
      } catch (error) {
        try { cancelSchedule(timer); } catch { /* nothing further can be done; report the original */ }
        throw error;
      }
    };
    scheduleCleanup();
    return Object.freeze({
      selfId,
      handle,
      /**
       * READ-ONLY view of this process's audit-cleanup state. Pure: it builds a frozen copy of the
       * in-memory records and does no I/O, no retry and no pruning, so calling it is never an
       * attempt and can never change a byte on disk.
       *
       * Shapes:
       *   · per side: `{ state, code?, lastAttemptAt?, lastSuccessAt?, lastRemoved? }`
       *   · `schedule`: `{ state: 'scheduled'|'stopped', code? }`
       *
       * ⚠️ WHAT `database.state` / `files.state` CAN ACTUALLY BE: `disabled`, `ok` or `failed`.
       * `idle` exists in `CLEANUP_STATE` only as the record's INITIAL value, and both prunes run
       * inside this factory BEFORE the handle is returned — so by the time anyone can call this
       * method, no side is `idle` any more. `idle` is therefore never observable from outside; it
       * is listed in `CLEANUP_STATE` for the records' own initialisation, not as a public state.
       *
       * `disabled` means "not configured" (no `auditJsonlDir`) and implies the filesystem was never
       * touched. `state:'failed'` carries a CLOSED-SET code — never an exception message, a stack,
       * a path, an audit body or a credential.
       */
      /**
       * WHICH DATABASE the plugin-backed routes are reading, and whether they are available at all.
       *
       * Facts only, and the honest ones: `available:false` means the plugin has never run here (no
       * file), or the file could not be opened. Nothing is invented to make it look served — a caller
       * that wants to say "unknown" has no basis to say anything else.
       */
      pluginStateInfo: () => Object.freeze({
        configured: pluginStatePath !== undefined,
        available: typeof pluginStore === 'object' && pluginStore !== null,
        ...(pluginStatePath === undefined ? {} : { path: pluginStatePath }),
      }),
      auditCleanupStatus() {
        return Object.freeze({
          database: projectSide(cleanup.database),
          files: projectSide(cleanup.files),
          schedule: Object.freeze({
            state: cleanup.schedule.state,
            ...(cleanup.schedule.code === undefined ? {} : { code: cleanup.schedule.code }),
          }),
        });
      },
      close: () => {
        closed = true;
        cancelSchedule(timer);
        cleanup.schedule.state = SCHEDULE_STATE.stopped;
        cleanup.schedule.code = CLEANUP_CODE.closed;
        // THE BROKER IS CLOSED BEFORE THE STORE, AND ITS FAILURE IS CONTAINED. `close()` releases
        // every pending ticket as "not approved" (the broker's own contract), so nothing is left
        // holding a timer or a promise after the console is gone. Both sides are guarded for the same
        // reason this method already cancelled the timer unconditionally: cleanup must not stop
        // halfway and leave the OTHER resource open. `close` is optional on the broker object (the
        // gateway never requires it), so it is called only when the factory supplied it.
        try { operationApprovalsBroker?.close?.(); } catch { /* nothing further can be done */ }
        // The plugin handle is a SECOND database; closing only `store` would leak it for the lifetime of
        // the process. Both closes are guarded independently so one failing cannot leave the other open.
        try { pluginStore?.close?.(); } catch { /* the console's own handle is still closed below */ }
        store.close();
      },
    });
  } catch (error) {
    // Construction failed with the store already open. The ORIGINAL error is what the caller gets:
    // the approval source is released first (same order as `close()`, and it can only ever be
    // undefined when the factory was never reached), then the store, and any failure of those two
    // releases is swallowed so it cannot mask the real reason the console was not created.
    try { operationApprovalsBroker?.close?.(); } catch { /* the original error wins */ }
    // Release the plugin handle too: a half-built runtime must not keep a second SQLite file open.
    try { pluginStore?.close?.(); } catch { /* the original error wins */ }
    try { store.close(); } catch { /* the original error wins */ }
    throw error;
  }
}
