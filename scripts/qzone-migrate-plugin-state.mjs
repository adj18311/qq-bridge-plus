#!/usr/bin/env node
// ONE-SHOT MIGRATION for `state/qzone-plugin-state.sqlite` — run BY HAND, once.
//
// WHY THIS EXISTS
// ---------------
// The live plugin database predates two fields the console's validators require:
//   · `intervalMinutes` — `validatePatrolInterval` demands an integer >= 15;
//   · `probe`           — `validateManagementState` demands one of
//                         {waiting, claimed, manual_only, done}.
// With either missing, `GET /status`, `POST /quota/reset` and `POST /pause/restore` answer 500.
// The fields are supplied below; NOTHING ELSE in the database is touched.
//
// USAGE
// -----
//   node scripts/qzone-migrate-plugin-state.mjs --dry-run     # report only, writes nothing
//   node scripts/qzone-migrate-plugin-state.mjs               # apply
//   node scripts/qzone-migrate-plugin-state.mjs --db <path>   # migrate a copy instead
//
//   Default DB: state/qzone-plugin-state.sqlite (resolved from the repository root).
//   --dry-run is the only safe way to look at a live database.
//
// RISK
// ----
// This rewrites the single `state` row. It is additive by construction (only absent keys are
// added, see `planMigration`) and runs inside ONE `BEGIN IMMEDIATE` transaction on the live file,
// so a concurrent writer is serialised rather than interleaved. It still MODIFIES PRODUCTION DATA:
//
//   TAKE A BACKUP FIRST.
//       Copy-Item state/qzone-plugin-state.sqlite state/qzone-plugin-state.sqlite.bak
//
// ROLLBACK
// --------
//   Stop the host, then copy the backup over the live file:
//       Copy-Item state/qzone-plugin-state.sqlite.bak state/qzone-plugin-state.sqlite -Force
//   `probe`/`intervalMinutes` are ordinary fields; deleting them by hand returns the database to
//   its pre-migration (broken) state, which is the state the backup already holds.
//
// WHAT IT REFUSES TO DO (deliberate, operator ruling D4=a)
// ------------------------------------------------------
//   · a database that is PAUSED and has no `probe` is REFUSED, not guessed at: that combination
//     is the signature of a recovery flow that did not finish, and inventing a probe state would
//     silently mark an interrupted recovery as complete;
//   · an EXISTING but ILLEGAL value is refused rather than overwritten — a value someone typed is
//     a statement, and "repairing" it would hide the mistake;
//   · a MISSING database is an error, never a fresh one. `openOfflineStore` creates the file
//     (`openSync(path, 'wx')`), which here would be indistinguishable from losing the real data.
//
// IDEMPOTENT: a second run reports "nothing to migrate" and writes nothing.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { validatePatrolInterval } from '../src/core/qzone-policy-offline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB = path.join(ROOT, 'state', 'qzone-plugin-state.sqlite');
/** The default the console uses (`qzone-console-runtime.mjs:303`), so a migrated DB matches it. */
const DEFAULT_INTERVAL_MINUTES = 100;
/** `validateManagementState`'s closed vocabulary (`qzone-admin-router-offline.mjs:23`). */
const PROBES = Object.freeze(['waiting', 'claimed', 'manual_only', 'done']);
/** The probe written when the database is NOT paused: "no recovery in flight". */
const PROBE_WHEN_NOT_PAUSED = 'done';
/**
 * Counted before and after the migration, and reported. These are the collections the operator
 * cares about; if any of them changed, this script has done something it was not asked to do.
 */
const PRESERVED_COLLECTIONS = Object.freeze([
  ['ledger.reservations', (state) => Object.keys(state?.ledger?.reservations ?? {}).length],
  ['audit', (state) => (Array.isArray(state?.audit) ? state.audit.length : null)],
  ['writeAudit', (state) => (Array.isArray(state?.writeAudit) ? state.writeAudit.length : null)],
  ['usedReadKeys', (state) => Object.keys(state?.usedReadKeys ?? {}).length],
  ['commentTargets', (state) => (Array.isArray(state?.commentTargets) ? state.commentTargets.length : null)],
  ['likes', (state) => (Array.isArray(state?.likes) ? state.likes.length : null)],
  ['notices', (state) => (Array.isArray(state?.notices) ? state.notices.length : null)],
]);

class MigrationRefused extends Error {
  constructor(message) { super(message); this.name = 'MigrationRefused'; }
}

/**
 * Decide what (if anything) this database needs. PURE — it never writes.
 *
 * Runs INSIDE the transaction callback in `applyMigration`, so the state it inspects is the one
 * the database holds at this instant. Never re-use a snapshot taken before the transaction:
 * another process may have written in between, and "decide from the old copy, write from the new"
 * is how a migration silently resurrects fields somebody just removed.
 *
 * @param {object} state the CURRENT row, from inside the transaction.
 * @returns {{changes: Array<{field: string, from: string, to: unknown}>}}
 * @throws {MigrationRefused} when the database needs a human rather than a patch.
 */
export function planMigration(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new MigrationRefused('the state row is not a JSON object; refusing to touch it');
  }
  const changes = [];

  // ── intervalMinutes ──────────────────────────────────────────────────────────────────────
  // Three cases, and only the first one writes.
  if (!Object.hasOwn(state, 'intervalMinutes')) {
    changes.push({ field: 'intervalMinutes', from: 'missing', to: DEFAULT_INTERVAL_MINUTES });
  } else if (!validatePatrolInterval(state.intervalMinutes)) {
    throw new MigrationRefused(
      'intervalMinutes is present but invalid (' + JSON.stringify(state.intervalMinutes) + '); '
      + 'a valid value is an integer >= 15. Refusing to overwrite a value somebody set on purpose — '
      + 'fix it in the console or by hand, then re-run.',
    );
  }

  // ── probe ───────────────────────────────────────────────────────────────────────────────
  if (Object.hasOwn(state, 'probe')) {
    if (!PROBES.includes(state.probe)) {
      throw new MigrationRefused(
        'probe is present but is not one of ' + PROBES.join('/') + ' (' + JSON.stringify(state.probe) + '); '
        + 'refusing to overwrite it.',
      );
    }
    // Present and legal ⇒ leave it alone. This is what makes a second run a no-op.
  } else if (state.accessPaused === true) {
    // D4=a. A paused database with no probe cannot be migrated by inventing a state: the four
    // probe values mean "where is the recovery flow", and none of them is honest here.
    throw new MigrationRefused(
      'the database is PAUSED (accessPaused=true) and has no probe state. That combination is the '
      + 'signature of a recovery flow that did not finish, and there is no value this script can '
      + 'write that would be true. Handle the recovery by hand (console, or restore the backup), '
      + 'then re-run. Nothing has been changed.',
    );
  } else {
    changes.push({ field: 'probe', from: 'missing', to: PROBE_WHEN_NOT_PAUSED });
  }

  return { changes };
}

/** Apply ONE planned change to a shallow copy. Never mutates the state it was handed. */
function withChanges(state, changes) {
  const next = { ...state };
  for (const change of changes) next[change.field] = change.to;
  return next;
}

/**
 * Open the database for migration.
 *
 * ⚠️ `openOfflineStore` CREATES a missing file (`openSync(path, 'wx')`) and, on the creation path,
 * writes a fresh `state` row from whatever `initial` it was given. Pointed at a mistyped path that
 * is exactly what it would do — silently producing an empty, healthy-looking database in place of
 * the operator's real one. So the existence check happens FIRST, here, and no `initial` value is
 * ever supplied: by the time `openOfflineStore` runs, the file is known to exist, which makes it
 * take its `EEXIST` branch ("open the existing file, verify the table and row") every time.
 * A race between the check and the open can only turn a just-deleted file into the `missing state
 * table` error below — it cannot fabricate a database, because by then the file exists.
 */
function openExisting(file) {
  if (!existsSync(file)) {
    throw new MigrationRefused(
      'no database at ' + file + '. Refusing to create one: an empty database would look migrated '
      + 'while holding none of the operator\'s data. Check the path (or pass --db <path>).',
    );
  }
  // `openOfflineStore` calls `encode(initial)` BEFORE it looks at the file, so an `undefined`/`null`
  // seed throws even though it would never be used. An empty object is passed instead — and it can
  // never reach the database: with the file present, `openOfflineStore` takes the `EEXIST` branch
  // (`created === false`), which either finds the `state` table and uses the existing row, or
  // throws `missing state table` before any INSERT. Verified in `openOfflineStore`'s source: the only
  // INSERT is inside `if (!exists) { if (!created) throw ... }`.
  const NEVER_WRITTEN = Object.freeze({});
  return openOfflineStore(file, NEVER_WRITTEN);
}

function readCounts(state) {
  return Object.fromEntries(PRESERVED_COLLECTIONS.map(([name, count]) => [name, count(state)]));
}

/**
 * Run the migration. Exported so the self-test can call it without spawning a process.
 *
 * @param {{db?: string, dryRun?: boolean}} options
 * @returns {{status: 'nothing-to-do'|'planned'|'migrated', changes: Array, preserved: object}}
 * @throws {MigrationRefused} on every refusal described in the header.
 */
export function migrate({ db = DEFAULT_DB, dryRun = false } = {}) {
  const file = path.resolve(db);
  const store = openExisting(file);
  try {
    if (dryRun) {
      // Read-only path: `planMigration` is pure, so a dry run cannot write even by accident.
      const before = store.read();
      const plan = planMigration(before);
      return {
        status: plan.changes.length === 0 ? 'nothing-to-do' : 'planned',
        changes: plan.changes,
        preserved: readCounts(before),
      };
    }

    let changes = [];
    let preservedBefore;
    // ONE transaction. `store.update` opens `BEGIN IMMEDIATE`, hands the callback the CURRENT row,
    // and COMMITs the returned object — so the decision below and the write are the same instant.
    store.update((state) => {
      preservedBefore = readCounts(state);
      const plan = planMigration(state);
      changes = plan.changes;
      // Nothing to do ⇒ return the state UNCHANGED. `update` still commits an identical row, which
      // is why the caller-facing status says "nothing-to-do" rather than "migrated".
      return changes.length === 0 ? state : withChanges(state, changes);
    });
    const preservedAfter = readCounts(store.read());
    for (const [name] of PRESERVED_COLLECTIONS) {
      if (preservedBefore[name] !== preservedAfter[name]) {
        throw new Error('migration changed ' + name + ' (' + preservedBefore[name] + ' -> '
          + preservedAfter[name] + '); that is a bug — restore the backup');
      }
    }
    return {
      status: changes.length === 0 ? 'nothing-to-do' : 'migrated',
      changes,
      preserved: preservedAfter,
    };
  } finally {
    store.close();
  }
}

function parseArgs(argv) {
  const options = { db: DEFAULT_DB, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--db') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0) throw new MigrationRefused('--db needs a path');
      options.db = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new MigrationRefused('unknown argument: ' + arg);
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error('[migrate] ' + error.message);
    return 2;
  }
  if (options.help === true) {
    console.log('usage: node scripts/qzone-migrate-plugin-state.mjs [--db <path>] [--dry-run]');
    return 0;
  }
  console.log('[migrate] database: ' + path.resolve(options.db));
  console.log('[migrate] mode: ' + (options.dryRun ? 'DRY RUN (nothing will be written)' : 'APPLY'));
  try {
    const result = migrate(options);
    if (result.status === 'nothing-to-do') {
      console.log('[migrate] nothing to migrate — the database already has every field.');
    } else {
      for (const change of result.changes) {
        console.log('[migrate] ' + (options.dryRun ? 'would set ' : 'set ')
          + change.field + ': ' + change.from + ' -> ' + JSON.stringify(change.to));
      }
      console.log('[migrate] ' + (options.dryRun ? 'DRY RUN — no changes written.' : 'migrated.'));
    }
    const counts = Object.entries(result.preserved)
      .map(([name, count]) => name + '=' + (count === null ? 'n/a' : count)).join(' ');
    console.log('[migrate] preserved (must be unchanged): ' + counts);
    return 0;
  } catch (error) {
    if (error instanceof MigrationRefused) {
      console.error('[migrate] REFUSED: ' + error.message);
      console.error('[migrate] nothing was changed.');
      return 1;
    }
    // A locked database is NOT retried: retrying would turn "the host is still running" into a
    // wait loop whose outcome the operator cannot see. Say what happened and stop.
    const locked = error && typeof error === 'object'
      && (error.code === 'SQLITE_BUSY' || /database is locked/i.test(String(error.message ?? '')));
    if (locked) {
      console.error('[migrate] the database is locked (SQLITE_BUSY). The host is probably still '
        + 'running. Stop it (or wait) and re-run. Nothing was changed.');
      return 1;
    }
    console.error('[migrate] FAILED: ' + (error?.message ?? error));
    return 1;
  }
}

// Only run when invoked directly, so importing this file (the self-test does) executes nothing.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}