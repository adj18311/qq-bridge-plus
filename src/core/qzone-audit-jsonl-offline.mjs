// §7 audit sink: `<root>/YYYY-MM-DD.jsonl`, one JSON object per line, Beijing-day files, 7-day prune.
//
// WHY THIS MODULE EXISTS, AND HOW IT RELATES TO THE EXISTING AUDIT MODULE
// ---------------------------------------------------------------------
// `qzone-audit-offline.mjs` already owns the hard part — `formatAuditRecord` validates every field and
// redacts anything matching the `SENSITIVE` pattern — but it appends to an ARRAY inside the offline
// store. Task card §7 asks for on-disk JSONL under `state/qzone-audit/`, one file per Beijing day,
// pruned after 7 days. That is a different SINK, not a different audit policy, so this module is a new
// sink beside the old one rather than a rewrite of it. Nothing here re-implements validation or
// redaction: every row goes through `formatAuditRecord` first, and the redaction decision is whatever
// that function made.
//
// DESIGN POINTS WORTH KNOWING BEFORE CHANGING ANYTHING
// ----------------------------------------------------
// · ONE FILE PER BEIJING DAY. The name is `beijingDay(record.time) + '.jsonl'`, computed from the
//   RECORD's timestamp (not from the clock at write time), so a record that arrives slightly late
//   still lands in the file its own `time` belongs to. Day boundaries follow `beijingDay` — the same
//   function the quota ledger uses — so "which day is it" can never disagree between audit and quota.
//
// · APPEND, NEVER REWRITE. Each row is one `appendFileSync` of `JSON.stringify(record) + '\n'`.
//   Rewriting the file would need a read-modify-write with a lost-update window; appending a single
//   line under the OS's O_APPEND semantics does not. A process that dies mid-append can leave a
//   partial trailing line, which is why `read()` surfaces raw lines (so a caller can see the damage)
//   instead of pretending to parse them.
//
// · PRUNE USES THE POLICY, NOT A LOCAL RULE. `auditRetentionDecision(name, now)` already encodes
//   "7 days, ignore anything that is not a valid day-named .jsonl, never touch the future". This
//   module only supplies the directory listing. Files that are not day-named `.jsonl` are never
//   candidates — a `.txt` or a `notes.md` beside them is left alone by construction.
//
// · PATH SAFETY IS STRUCTURAL. `root` must be an absolute path supplied by the caller. File names are
//   never taken from the caller: they are DERIVED from a validated day string, and `read(dayName)`
//   re-validates that shape. `..`, separators and drive letters cannot appear in a string that must
//   match `^\d{4}-\d{2}-\d{2}$`, so traversal is impossible rather than filtered.
//
// · AUDIT GAPS DO NOT ENTER THIS SINK (M10). `state.auditGaps` holds a different kind of record:
//   `{ key, reason, generation, time, resolvedBy }` from `formatAuditGap` — the record of an audit row
//   that FAILED to be written. It is corroborating evidence about a MISSING row, not an operation
//   audit: it has no `action`, no `target`, no `result`, and no `content`, by design (G-2/G-5). So it
//   is not "filtered out" here — it cannot get in: every row goes through `formatAuditRecord` first,
//   and that formatter rejects the gap shape before any I/O happens (`node --test
//   scripts/test-qzone-audit-jsonl-gap-boundary.mjs` pins this, including that not even the directory
//   gets created and that an existing day file's bytes are unchanged after a rejected attempt).
//   Do NOT add an `appendGap`/`appendAuditGap` escape hatch here: writing gaps into this file would
//   make one line-per-record stream ambiguous (is this line an operation or a gap?) and would let a
//   gap be mistaken for operation evidence. Gaps stay in `state.auditGaps`, where the write gate
//   reads them. By contrast, the M9 recovery/management audit (`action:'restore'` etc., with
//   `operator`/`pauseScope`) IS an operation audit and is accepted normally.
//
// · WHAT THIS FILE'S VALIDATION DOES **NOT** PROVE. `formatAuditRecord` is an allowlist shape check,
//   not provenance or intent checking. A caller that forges an object carrying BOTH the gap fields and
//   a complete valid operation-audit set will be accepted as an operation audit (the gap fields are
//   dropped by the allowlist, so they never reach disk). Authorisation belongs to the authenticated
//   entry points, not to this file-I/O sink. See `AJ-7` for the measured scope statement.
//
// · REBUILDING THE FILES FROM `state.audit` (the exporter at the bottom of this file). `state.audit`
//   is the durable authority; these files are a projection of it. The exporter's whole job is to make
//   that projection REPEATABLE: running it twice over one snapshot must not double the rows, and a
//   failed write must be visible instead of silently "already done".
//
//   How de-duplication works — and what it deliberately does NOT use. The row carries an identity in
//   its own field (`auditId` = `<namespace>:<state.audit[i].id>`), and "has this row been delivered?"
//   is answered by RE-READING THE DAY FILE and collecting the `auditId`s already in it. There is no
//   delivery ledger, because a ledger adds a second thing to keep in sync and a real window: append
//   succeeds, ledger write fails, and the retry duplicates the row. With the file as the only record
//   of what was delivered, that window does not exist. The cost is honest and stated: a damaged
//   (unparseable) line is NOT counted as delivered, so it is re-appended on the next run — and the
//   damaged line is never deleted or rewritten (see `corruptLines`).
//
//   The identity is written as an EXTRA FIELD AFTER `formatAuditRecord`'s output, never inside it, and
//   the identity is a plain string — NOT a digest over the record. A digest would inherit the same
//   field-order sensitivity that makes `settled` keys fragile; a plain `namespace:id` is stable across
//   reordering, re-serialisation and process restarts.
//
//   `redacted` NEVER DOWNGRADES. `formatAuditRecord` derives `redacted` by testing the CONTENT, so
//   re-formatting an already-redacted row (`content: '[REDACTED]'`) would report `redacted:false` —
//   the flag would lie about a row that is still redacted. The exporter therefore passes the stored
//   flag through the sink's optional `previouslyRedacted`, and the sink ORs it with its own finding.
//   The flag can only be raised, never lowered, and re-redaction still happens.
//
//   TWO INDEPENDENT 7-DAY POLICIES — DO NOT CONFLATE THEM. `prune()` deletes expired DAY FILES; it
//   does not remove anything from `state.audit`. `pruneOfflineAudit()` (in `qzone-audit-offline.mjs`)
//   removes entries from `state.audit`; it does not delete any file. So "deleting files does not
//   delete store rows" and "deleting store rows does not delete files". The exporter calls NEITHER:
//   it is a pure projection and never shortens either side.
//
// WHAT THIS IS NOT
// ----------------
//   · NOT wired into production: nothing in `src/bridge.js` or `plugins/**` references it.
//   · NOT a rotation/compaction system. Prune deletes whole expired day files; it never edits a live
//     file, never merges files, and never truncates.
//   · NOT a durability guarantee beyond "the bytes were handed to the OS". There is no fsync here.
//   · NOT a second gate for audit gaps. It never reads, writes or prunes `state.auditGaps`.
//   · NOT an atomic multi-file/multi-process exporter. Each row is one independent append; a crash
//     between two rows leaves the earlier ones delivered and the later ones not yet delivered, which
//     the next run simply continues. Nothing claims a whole day lands "all or nothing".

import fs from 'node:fs';
import path from 'node:path';

import { formatAuditRecord } from './qzone-audit-offline.mjs';
import { auditRetentionDecision, beijingDay } from './qzone-policy-offline.mjs';

/** A day-named file this module owns. Nothing else in the directory is ever touched. */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * The exporter's row identity: a plain string, never a digest.
 *
 * `namespace` is caller-supplied and stable across restarts (a config value, not a clock or a process
 * token), so the SAME store row produces the SAME identity in a later process. The id half is
 * `state.audit[i].id`, which is already the store's own key. Nothing here is derived from the record's
 * fields, so reordering `formatAuditRecord`'s output cannot change an identity.
 *
 * THE SHAPE IS THE COMPOSITION OF THE TWO GRAMMARS, and it has to be: with only one colon allowed here,
 * a `read:<hex>` row would be exportable but its own output line would then be rejected by
 * `scanDelivered` (which validates this same field), so the next run would see "not delivered" and
 * append the row AGAIN — forever. Hence a SECOND optional colon: `<namespace>:<namespace-less id>`,
 * i.e. 1 or 2 colons total, each segment a bounded safe id. Still a closed set:
 * `ns:a:b:c`, `ns:a b`, `ns:/etc/passwd`, `ns:` and `ns::x` all remain refused.
 */
const AUDIT_ID = Object.freeze({
  field: 'auditId',
  shape: /^[A-Za-z0-9_-]{1,64}:(?:[A-Za-z0-9_-]{1,128}|[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128})$/,
});

/** Namespace: caller-supplied, safe-id shaped, at most 64 chars. */
const NAMESPACE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `state.audit[i].id` — the store's own audit id shape.
 *
 * TWO SEGMENTS, AT MOST ONE COLON. This used to be `/^[A-Za-z0-9_-]{1,128}$/` (no colon at all), and
 * that WAS A REAL, MEASURED DEFECT rather than a conservative choice: producers in this repo mint ids
 * that carry a colon, so the exporter classified those rows as unusable and still reported
 * `failed:false`. Measured on the real plugin database (read-only): `state.audit` held 34 rows, 7 of
 * them `read:<32hex>`, and `exportAll` returned `exported:27 / failed:false` while skipping all 7.
 *
 * The producers, read out of the source rather than assumed:
 *   · `dsp_<32hex>`            qzone-runtime-wiring.mjs:478-482 (`dsp_${attemptKey}`, attemptKey is sha256[0..32])
 *   · `read_intent_<id>`       qzone-read-reservation-offline.mjs:58 (goes through appendOfflineAudit, i.e. safe id)
 *   · `read:<id>`              qzone-settlement-offline.mjs:129 (`read:${id}`)
 *   · `write:<id>`             qzone-settlement-offline.mjs:108 (`write:${id}`)
 *   · `auth_<uuid>_intent` / `auth_<uuid>_outcome`   qzone-column-auth-audit-offline.mjs:64-65
 *   · `probe_intent_<id>` / `probe_result_<id>`      qzone-recovery-offline.mjs:26,47
 *
 * So the shape is the COMPOSITION `<safe-id>(:<safe-id>)?` — ONE or TWO segments, one optional colon.
 * Deliberately narrower than "anything with a colon":
 *   · every character still comes from `[A-Za-z0-9_-]` (no space, no quote, no `/`, no `..`, no control);
 *   · each segment is length-bounded, and `a:b:c` (two colons in the id itself) is still REFUSED;
 *   · the id is embedded in the export VERBATIM — this is NOT an escaping or re-encoding scheme, so
 *     `read:<hex>` in SQLite stays `read:<hex>` in the JSONL and a human can match them by eye.
 */
const STORED_AUDIT_ID = /^[A-Za-z0-9_-]{1,128}(?::[A-Za-z0-9_-]{1,128})?$/;

const isDayName = (value) => typeof value === 'string' && DAY_FILE.test(value);

/**
 * @param root  - ABSOLUTE directory the caller owns (tests point at %TEMP%). Created on demand.
 * @param clock - `() => trusted millisecond timestamp`; used for prune's "today", never for the file
 *                name (that comes from the record's own `time`).
 */
export function createAuditJsonl({ root, clock } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('audit jsonl needs a root directory');
  if (typeof clock !== 'function') throw new TypeError('audit jsonl needs a clock()');
  // Absolute-only. A relative root would silently depend on the process CWD, which is exactly the
  // kind of accidental placement that ends up writing audit rows somewhere nobody looks.
  if (!path.isAbsolute(root)) throw new TypeError('audit jsonl root must be an absolute path');

  const ensureDir = () => { fs.mkdirSync(root, { recursive: true }); };

  /**
   * Make sure the file ends with a newline before appending, so a torn tail (a crash mid-write)
   * stays an independent line instead of being spliced together with the row we are about to write.
   *
   * Reads ONE byte. The file may not exist yet (nothing to do) and may be empty (nothing to do).
   */
  const terminateTornTail = (target) => {
    let size;
    try {
      size = fs.statSync(target).size;
    } catch (error) {
      if (error && error.code === 'ENOENT') return;   // first write: nothing to terminate
      throw error;                                     // a real stat failure must not be swallowed
    }
    if (size === 0) return;
    const fd = fs.openSync(target, 'r');
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) fs.appendFileSync(target, '\n', { encoding: 'utf8' });
    } finally {
      fs.closeSync(fd);
    }
  };

  /** Resolve a validated day name to a path INSIDE root. Throws for anything else. */
  const pathForDay = (day) => {
    if (!isDayName(`${day}.jsonl`)) throw new TypeError(`invalid audit day: ${String(day)}`);
    const name = `${day}.jsonl`;
    const target = path.join(root, name);
    // Belt and braces: even though the name is shape-validated, verify the resolved path really sits
    // directly inside root. This is what turns "the regex looks fine" into a checked property.
    if (path.dirname(target) !== path.resolve(root)) {
      throw new TypeError('audit path escapes the root directory');
    }
    return { name, target };
  };

  return Object.freeze({
    /**
     * Append ONE audit row. Throws on an invalid record (that is `formatAuditRecord`'s decision, not
     * this module's) and on any filesystem error — an audit sink that swallows write failures would
     * let the caller believe a row exists when it does not.
     *
     * @param input   - the operation-audit input, validated/redacted by `formatAuditRecord`.
     * @param options - `{ previouslyRedacted }`. OPTIONAL and BACKWARD COMPATIBLE: the single-argument
     *   call behaves exactly as before. `previouslyRedacted: true` means "this row was already
     *   redacted when it was stored", which lets a re-export keep `redacted:true`. It can only RAISE
     *   the flag (`record.redacted || previouslyRedacted`), never lower it: passing `false` for a row
     *   the formatter found sensitive does NOT clear it. Redaction itself is unaffected — the content
     *   still goes through `formatAuditRecord` and is still replaced when it matches.
     *
     * @returns {{ appended: true, path: string, name: string, redacted: boolean }}
     */
    append(input, options) {
      // Validation + redaction happen HERE, before any I/O, in the reviewed formatter.
      const record = formatAuditRecord(input);
      // `record` is rebuilt (not mutated) so the formatter's key ORDER is preserved exactly: spreading
      // its own output keeps insertion order, and the only change is the VALUE of `redacted`.
      const previouslyRedacted = options && options.previouslyRedacted === true;
      let delivered = previouslyRedacted && record.redacted !== true
        ? { ...record, redacted: true }
        : record;
      // The exporter's row identity, appended AFTER everything the formatter produced (and after the
      // management fields it appends for `restore`/`reset_quota`/`configure`). A closed pattern, not a
      // caller-supplied object: a row may carry ONE extra string and nothing else.
      const auditId = options?.auditId;
      if (auditId !== undefined) {
        if (typeof auditId !== 'string' || !AUDIT_ID.shape.test(auditId)) {
          throw new TypeError('audit jsonl: "auditId" must be "<namespace>:<audit id>" '
            + '(safe id, one colon, safe id)');
        }
        delivered = { ...delivered, [AUDIT_ID.field]: auditId };
      }
      const day = beijingDay(delivered.time);
      const { name, target } = pathForDay(day);
      ensureDir();
      // A CRASH CAN LEAVE A TAIL WITHOUT A NEWLINE. Appending directly onto it SPLICES the new row
      // onto the残 row: the残 row stops being an independent line, the NEW row also becomes unparseable,
      // and the next `scanDelivered` cannot see its `auditId` → the same row is appended AGAIN.
      // Measured before this fix: torn '{"partial' (no newline) → run1 exported:1, run2 exported:1,
      // file content `{"partial{"time":...` with 0 parseable lines. A fixture whose torn line HAD a
      // newline passed, which is why the original test missed it: a real crash rarely ends in '\n'.
      //
      // So: if the file does not end in a newline, terminate the damaged tail FIRST. The残 row keeps
      // its exact original bytes and simply becomes a line of its own (counted as corrupt on read),
      // and the row we are writing now starts on a clean line.
      terminateTornTail(target);
      // One line, one append. `JSON.stringify` cannot emit a newline inside the object, so appending
      // `\n` after it is sufficient to keep the file one-record-per-line.
      fs.appendFileSync(target, `${JSON.stringify(delivered)}\n`, { encoding: 'utf8' });
      return Object.freeze({ appended: true, path: target, name, redacted: delivered.redacted === true });
    },

    /**
     * Delete expired day files. Only names that `auditRetentionDecision` recognises as day-named
     * `.jsonl` are candidates; everything else in the directory is ignored (not deleted, not moved).
     *
     * @returns {{ removed: string[], kept: number }}
     */
    prune() {
      const now = clock();
      let entries;
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch (error) {
        // A missing directory simply has nothing to prune. Anything else is a real error.
        if (error && error.code === 'ENOENT') return Object.freeze({ removed: Object.freeze([]), kept: 0 });
        throw error;
      }
      const removed = [];
      let kept = 0;
      for (const entry of entries) {
        if (!entry.isFile()) continue;         // never follow directories or symlinks
        const name = entry.name;
        if (!isDayName(name)) continue;        // a `.txt` / `.md` beside them is not ours
        const decision = auditRetentionDecision(name, now);
        if (decision === 'expired') {
          fs.unlinkSync(path.join(root, name));
          removed.push(name);
        } else if (decision === 'keep' || decision === 'future') {
          kept += 1;
        }
      }
      return Object.freeze({ removed: Object.freeze(removed), kept });
    },

    /**
     * Raw lines of one day file, in file order. Test/diagnostic aid.
     *
     * Deliberately returns STRINGS rather than parsed objects: if a crash left a partial trailing
     * line, a parser here would either throw or silently drop it. The caller decides.
     *
     * @param dayName - `YYYY-MM-DD`, the day the caller wants. Never a path.
     */
    read(dayName) {
      const { target } = pathForDay(dayName);
      let text;
      try {
        text = fs.readFileSync(target, 'utf8');
      } catch (error) {
        if (error && error.code === 'ENOENT') return Object.freeze([]);
        throw error;
      }
      if (text === '') return Object.freeze([]);
      // A trailing newline is the normal state; splitting yields one empty tail element to drop.
      const lines = text.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return Object.freeze(lines);
    },

    /** Resolved directory, for tests and operator diagnostics. */
    root() { return path.resolve(root); },
  });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// REBUILDING THE JSONL FROM `state.audit`
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// WHY. `state.audit` (the store array) and `state/qzone-audit/YYYY-MM-DD.jsonl` (these files) are two
// sinks for the same decisions, and the array is the durable authority the gate/operator reads. If the
// files are lost, truncated, or were never written for a stretch of time, they must be REBUILDABLE from
// the array without guessing: same rows, same identity, no duplicates, and a failure that is visible.
//
// RETRY SAFETY WITHOUT A LEDGER. "Already delivered" is answered by the file itself: read the day file,
// collect the identities it already carries, append only what is missing. A second run over an unchanged
// store therefore appends nothing. There is no separate ledger to fall out of sync, and — importantly —
// no window of the shape "the append succeeded but the ledger write failed", which would duplicate a row
// on the next attempt. The trade-off is stated rather than hidden: an unparseable line is NOT counted as
// delivered (its identity cannot be read), so the matching row is appended again on the next run, and the
// damaged line is left in place untouched. `corruptLines` reports how many such lines exist.
//
// WHAT IS **NOT** CLAIMED. This is not atomic across rows, days or processes, and it is not a background
// service: `exportDay`/`exportAll` do work only when called. Two concurrent exporters can each decide a
// row is missing and both append it; nothing here prevents that, and nothing pretends to.
//
// RETENTION IS NOT TOUCHED HERE. `prune()` (files) and `pruneOfflineAudit()` (store rows) stay separate
// and neither is called by the exporter — see the module header for the two independent 7-day policies.

/**
 * The CLOSED set of failure categories an audit export can report.
 *
 * `error` (below) is an internal diagnostic string and may contain text from the very data that failed
 * to parse — a `JSON.parse` message literally quotes the input: measured
 * `SyntaxError: Unexpected token 'S', "SYNTHETIC_"... is not valid JSON`. Anything that prints to a
 * human must therefore use `failureCode`, never `error`.
 */
const FAILURE_CODE = Object.freeze({
  STORE_UNREADABLE: 'store-unreadable',
  STORE_SHAPE_INVALID: 'store-shape-invalid',
  DAY_FILE_UNREADABLE: 'day-file-unreadable',
  DAY_FILE_CONFLICT: 'day-file-conflict',
  SOURCE_ROW_REJECTED: 'source-row-rejected',
  SOURCE_ROWS_CONFLICT: 'source-rows-conflict',
  EXPORT_CONFLICT: 'export-conflict',
  APPEND_FAILED: 'append-failed',
});

/**
 * Map a thrown value to a controlled category.
 *
 * The CLASSIFICATION may look at the message (that is internal); the RESULT is always one of the
 * fixed tokens above, so no caller can end up echoing source data.
 */
function failureCodeOf(error) {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (name === 'SyntaxError' || /is not valid JSON|JSON/i.test(message)) return FAILURE_CODE.STORE_UNREADABLE;
  if (/invalid audit record/i.test(message)) return FAILURE_CODE.SOURCE_ROW_REJECTED;
  if (/audit array/i.test(message)) return FAILURE_CODE.STORE_SHAPE_INVALID;
  if (/missing state|invalid state|unable to open database file/i.test(message)) {
    return FAILURE_CODE.STORE_UNREADABLE;
  }
  return FAILURE_CODE.APPEND_FAILED;
}

/**
 * The CLOSED set of reasons a source row was not exportable.
 *
 * Reported by COUNT only, per cause. An operator has to be able to tell "rows carry an id this version
 * does not accept" from "rows are corrupt", and neither answer may echo the offending value: the module's
 * existing discipline (`failureCodeOf` reports a category precisely so a `JSON.parse` message quoting the
 * input never escapes) applies to source ids too.
 */
const SKIP_CAUSE = Object.freeze({
  /** `entry` is not an object at all (null / array / primitive): nothing to identify it by. */
  unidentifiableEntry: 'unidentifiable-entry',
  /** `entry.id` is missing, not a string, or not `<safe-id>(:<safe-id>)?`. */
  invalidId: 'invalid-id',
  /** `entry.record` is missing or not a record object. */
  invalidRecord: 'invalid-record',
  /** `record.time` is not a usable timestamp (non-finite, or outside `Date` range after the BEIJING shift). */
  unusableTime: 'unusable-time',
});

/**
 * THE COMPLETENESS VOCABULARY — three values answering three different questions.
 *
 *   `complete`    every source row of the covered live days is on disk. Nothing was refused.
 *   `incomplete`  the run finished, but at least one source row is NOT on disk because this exporter
 *                 refused it. `failed` can still be `false`: "the day file is intact and the run
 *                 finished" is a different statement from "the projection is whole".
 *   `unknown`     the run cannot be assessed (store unreadable, or the day file unreadable /
 *                 self-contradicting so "already delivered" is undeterminable). NEVER `complete`.
 *
 * WHY THIS IS SEPARATE FROM `failed`: `failed` means "the export was interrupted / a row could not be
 * WRITTEN", and existing callers (scripts/qzone-admin-cli.mjs:321-325) depend on exactly that meaning.
 * A refused row interrupts nothing — the run proceeds and the day file is valid — yet the projection is
 * still short. That gap is what produced the measured lie: 7 of 34 real rows skipped, `failed:false`.
 *
 * RETENTION IS NOT A LOSS. An EXPIRED day is not projected BY DESIGN, so it never yields `incomplete`;
 * its exclusion is reported on its own terms (`skippedExpired` / `skippedExpiredDay`). Charging it here
 * would mark every store older than seven days permanently `incomplete`, i.e. train callers to ignore
 * the field — which is precisely how the old `failed:false` lie survived.
 */
const COMPLETENESS = Object.freeze({
  complete: 'complete',
  incomplete: 'incomplete',
  unknown: 'unknown',
});

/**
 * Counters every `exportDay` starts from; the failure branch spreads this to keep the keys uniform.
 *
 * `lostIds` is a NUMBER OF DISTINCT STORE ROWS, and that is the whole point of it existing beside
 * `skippedInvalid`: `skippedInvalid` is accumulated per day, so ONE unusable row is counted once for
 * every day the exporter walks and inflates to (rows × days) — measured `skippedInvalid:14` for 7 real
 * lost rows. `lostIds` comes from a Set keyed by the raw id, so it is the number a human can compare
 * against "how many rows are in SQLite". `skipCauses` is per-ROW counts (two rows sharing one id are
 * still two refusals), by closed cause token.
 */
const EMPTY_DAY = Object.freeze({
  exported: 0, alreadyPresent: 0, corruptLines: 0, failed: false,
  complete: COMPLETENESS.complete, lostIds: 0, skipCauses: Object.freeze({}),
});

/**
 * Read one day file and split it into "identities already delivered" and "lines that cannot be parsed".
 *
 * A line without an `auditId` is NOT a corrupt line: rows written by the plain `append()` path (or by
 * hand) have no identity, so they cannot match anything and must not be reported as damage.
 */
/**
 * The EXPORT REPRESENTATION of one audit row, used for BOTH writing and comparing.
 *
 * Comparison happens on this projection, never on the raw store object: the store holds `{id, record}`,
 * while the file holds `formatAuditRecord(record)` plus `auditId`. Comparing those directly would
 * compare two different shapes. Everything that decides "is this row already on disk" runs through
 * ONE function so the write side and the read side cannot drift apart.
 *
 * NO DIGEST. A `sha256(JSON.stringify(...))` identity is field-ORDER sensitive — the same fragility
 * that `settled` already suffers from. A field-by-field comparison is explicit, debuggable, and says
 * WHICH field differs.
 */
function projectRow(record, auditId) {
  const formatted = formatAuditRecord(record);
  // `redacted` can only be RAISED. A row stored with `redacted:true` keeps that claim when re-exported,
  // even if its content would no longer be detected as sensitive; it can never be lowered, so a
  // re-export can never turn a redacted row back into a plaintext one.
  const withFlag = record.redacted === true && formatted.redacted !== true
    ? { ...formatted, redacted: true }
    : formatted;
  return { ...withFlag, [AUDIT_ID.field]: auditId };
}

/**
 * Is this parsed line a COMPLETE audit row?
 *
 * The field set is exactly what `formatAuditRecord` guarantees: these values are always present with
 * these types. Optional/management extras (`operator`, `pauseScope`, and the nullable `postId`,
 * `commentId`, `quota`) are NOT required — they legitimately appear as `null` or not at all.
 *
 * Anything failing this is a fragment, and a fragment must never be able to shadow a real row.
 */
function isCompleteAuditRow(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!Number.isFinite(value.time)) return false;
  for (const field of ['source', 'action', 'target', 'content', 'result', 'reason']) {
    if (typeof value[field] !== 'string') return false;
  }
  if (typeof value.redacted !== 'boolean') return false;
  return true;
}

/** Fields compared when deciding whether an on-disk row is the SAME export as a source row. */
const COMPARED_FIELDS = Object.freeze([
  'time', 'source', 'action', 'target', 'postId', 'commentId',
  'content', 'redacted', 'result', 'reason', 'quota', 'operator', 'pauseScope',
]);

/** `null`/absent are the same thing on disk; everything else is compared by strict equality. */
const sameValue = (a, b) => (a === undefined ? null : a) === (b === undefined ? null : b);

/**
 * Compare two projected rows. Returns `null` when they agree, or the name of the first differing
 * field. A field present in one and absent in the other also differs (`sameValue` folds undefined→null,
 * which is the only normalisation applied).
 */
function firstDifference(expected, actual) {
  for (const field of COMPARED_FIELDS) {
    if (!sameValue(expected[field], actual[field])) return field;
  }
  const extraExpected = Object.keys(expected).filter((k) => !COMPARED_FIELDS.includes(k) && k !== AUDIT_ID.field);
  const extraActual = Object.keys(actual).filter((k) => !COMPARED_FIELDS.includes(k) && k !== AUDIT_ID.field);
  if (extraExpected.length !== extraActual.length) return '(shape)';
  return null;
}

/**
 * Read one day file and split it into "identities already delivered WITH their content" and damage.
 *
 * ⚠️ WHY AN IDENTITY ALONE IS NOT DELIVERY (measured counterexamples, both real):
 *   · A row `{auditId:'ns:a', time:…, action:'like', result:'success'}` — no source/target/content —
 *     made the real `ns:a` permanently unexportable: `{exported:0, alreadyPresent:1, hasContent:false}`.
 *   · A COMPLETE but DIFFERENT row with the same `auditId` (content=`different`) was reported as
 *     `alreadyPresent` even though the authoritative SQLite content was never exported.
 * "Looks like a row" and "is the row we would have written" are different questions. So this keeps the
 * PROJECTION per identity and lets the caller compare content, and a row that is not a valid audit row
 * at all is counted as damage instead of shadowing anything.
 */
function scanDelivered(lines, log) {
  const delivered = new Map();
  let corruptLines = 0;
  const conflicts = [];
  for (const line of lines) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { corruptLines += 1; continue; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { corruptLines += 1; continue; }
    const identity = parsed[AUDIT_ID.field];
    if (identity === undefined) continue;          // no identity: neither delivered nor damage
    if (typeof identity !== 'string' || !AUDIT_ID.shape.test(identity)) { corruptLines += 1; continue; }
    // MUST BE A COMPLETE AUDIT ROW, not merely "has an id and looks row-ish". `formatAuditRecord` always
    // emits a fixed set of fields, so a line missing any of them is a fragment (a torn write, a hand
    // edit, another tool's output) — damage, NOT a delivery that disagrees with the source.
    //
    // Measured counterexample (Codex A-1): `{auditId:'ns:a', time, action:'like', result:'success'}` —
    // no source/target/content — passed the old three-field check, was treated as a CONFLICT, and the
    // authoritative row was never exported. Classifying it as damage instead lets the real row land.
    if (!isCompleteAuditRow(parsed)) {
      corruptLines += 1;
      continue;
    }
    if (delivered.has(identity)) {
      // The FILE itself contains two rows claiming the same identity. That is damage, not delivery:
      // one of them cannot be the row we would have written unless they agree exactly, and we cannot
      // tell which is authoritative. Report it rather than picking one silently.
      const previous = delivered.get(identity);
      if (firstDifference(previous, parsed) !== null) {
        conflicts.push({ auditId: identity, field: '(duplicate identity in file)' });
        continue;
      }
      corruptLines += 1;
      continue;
    }
    delivered.set(identity, parsed);
  }
  return { delivered, corruptLines, conflicts };
}

/**
 * Build an exporter that projects `store.read().audit` into the JSONL sink.
 *
 * @param store     - the offline store (`read()`), whose `audit` array is `[{ id, record }]`.
 * @param jsonl     - a sink built by `createAuditJsonl` (this module). Never constructed here: one
 *                    root/clock decision stays in one place.
 * @param namespace - caller-supplied, stable across restarts (`^[A-Za-z0-9_-]{1,64}$`). NOT a clock, a
 *                    PID or a random token: the identity must be reproducible by a later process.
 * @param clock     - REQUIRED. The retention window is decided by this trusted "now"; without it the
 *                    exporter cannot tell an expired row from a current one and would happily re-create
 *                    a day file that pruning just removed. A row's DAY still comes from the row's own
 *                    `time` — day membership and retention eligibility are two different questions.
 */
export function createAuditExporter({ store, jsonl, namespace, clock } = {}) {
  if (!store || typeof store.read !== 'function') throw new TypeError('audit exporter needs a store with read()');
  if (!jsonl || typeof jsonl.append !== 'function' || typeof jsonl.read !== 'function') {
    throw new TypeError('audit exporter needs a jsonl sink with append() and read()');
  }
  if (typeof namespace !== 'string' || !NAMESPACE.test(namespace)) {
    throw new TypeError('audit exporter needs a namespace matching ^[A-Za-z0-9_-]{1,64}$ '
      + '(supplied by the caller and stable across restarts)');
  }
  // REQUIRED, not optional. Measured counterexample: with a fixed `now` and a 30-day-old source row,
  // `exportAll → prune → exportAll` reported `{firstExported:1, pruned:true, secondExported:1}` and the
  // file came BACK. Without a trustworthy clock the exporter cannot honour "never resurrect an expired
  // source record", so it refuses to run rather than pretend a retention policy it cannot apply.
  if (typeof clock !== 'function') {
    throw new TypeError('audit exporter needs a trusted clock(): expired rows must never be re-exported '
      + '(day membership comes from the row, retention eligibility comes from now)');
  }

  /**
   * The store's audit array, validated as an array. A non-array is REFUSED rather than read as "empty":
   * "no rows to export" and "the array is corrupt" must never produce the same report.
   *
   * THE SNAPSHOT IS TAKEN ONCE PER TOP-LEVEL OPERATION. `exportAll` used to call `days()` (one read) and
   * then `exportDay()` per day (one read EACH), so a row committed between two of those reads landed in
   * the SAME run — measured `{exported:3, lateInFirstRun:true}` for a store that held 2 rows at entry.
   * A single snapshot makes "this run exports what existed when it started" a property of the code
   * instead of a hope.
   */
  const snapshot = () => {
    const state = store.read();
    const audit = state && typeof state === 'object' ? state.audit : undefined;
    if (!Array.isArray(audit)) {
      throw new TypeError('audit exporter: store state has no audit array '
        + '(refusing to report a corrupt store as "nothing to export")');
    }
    // ⚠️ A LIVE REFERENCE IS NOT A SNAPSHOT. `state.audit` is the array the store hands out; a row
    // committed while this run is in flight would MUTATE it in place and be picked up by the very same
    // run. Measured before this copy: 2 rows at entry `{exported:3}` — the third was committed from
    // inside the first `append` callback and landed in the first run.
    //
    // A shallow copy is enough and is also the honest boundary: entries are read field-wise
    // (`id`, `record`), and `record` is projected through `formatAuditRecord` which rebuilds a fresh
    // closed-shape object. No new persistent collection is introduced — this array dies with the call.
    return audit.slice();
  };

  /**
   * Beijing day for a stored `time`, or `null` when it is not a usable timestamp.
   *
   * `Number.isFinite` is NOT enough: `formatAuditRecord` accepts `time: 1e17`, and `beijingDay` throws
   * `RangeError: timestamp out of range` on it. Measured before this fix: ONE such row made
   * `days()`, `status()`, `exportDay()` and `exportAll()` ALL throw — the whole exporter dead from a
   * single malformed row. `pruneOfflineAudit` already guards this the same way
   * (`qzone-audit-offline.mjs`); this mirrors it.
   */
  const dayOf = (time) => {
    if (!Number.isFinite(time)) return null;
    try {
      return beijingDay(time);
    } catch {
      return null;
    }
  };

  /**
   * Is a day still inside the retention window, judged by the TRUSTED clock?
   *
   * Uses the SAME policy function the file pruner uses (`auditRetentionDecision` on a day-named file),
   * so the exporter and `createAuditJsonl().prune()` cannot disagree about which days are expired.
   * 'future' is kept (the pruner also keeps it), and anything the policy does not call 'expired' is
   * exportable. NO NEW TTL RULE IS INTRODUCED.
   */
  const isLiveDay = (day) => auditRetentionDecision(`${day}.jsonl`, clock()) !== 'expired';

  /**
   * One store entry → a candidate row for a given day, or a skip reason.
   *
   * Returns `{ candidate }` or `{ skip: 'other-day' | 'invalid' | 'expired' }`. Three separate cases
   * because they mean three different things: a different day is NORMAL, a malformed row is damage, and
   * an EXPIRED row must be skipped loudly — exporting it would re-create a file that pruning removed.
   */
  const classify = (entry, day) => {
    const shape = shapeOf(entry);
    if (shape.cause !== undefined) return { skip: 'invalid', cause: shape.cause, lostKey: shape.lostKey, day: shape.day };
    if (shape.day !== day) return { skip: 'other-day' };
    return { candidate: { id: shape.id, record: shape.record, day: shape.day,
      auditId: `${namespace}:${shape.id}` } };
  };

  /**
   * The SHAPE half of `classify`: what this entry is, independent of which day is being exported.
   *
   * WHY IT IS SPLIT OUT: the per-day loop and the run-level accounting must answer "is this row usable"
   * with the SAME rule, or the completeness verdict would describe a different population than the
   * export did. One function, two callers.
   *
   * THE DAY IS RESOLVED BEFORE THE ID IS JUDGED, on purpose: a row whose record is fine but whose id is
   * rejected still BELONGS to a real day, and charging it to that day keeps the per-day numbers exact
   * instead of dumping every id problem into "unattributable". `day` is `null` only when the record
   * itself is unusable.
   */
  const shapeOf = (entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      // No id at all: nothing to dedupe by, so this one can be counted but never identified.
      return { cause: SKIP_CAUSE.unidentifiableEntry, lostKey: null, day: null };
    }
    const { id, record } = entry;
    const recordUsable = record !== null && typeof record === 'object' && !Array.isArray(record);
    const entryDay = recordUsable ? dayOf(record.time) : null;
    if (typeof id !== 'string' || !STORED_AUDIT_ID.test(id)) {
      // A non-string id has nothing to dedupe on; a wrong-SHAPED string still does.
      return { cause: SKIP_CAUSE.invalidId, lostKey: typeof id === 'string' ? id : null, day: entryDay };
    }
    if (!recordUsable) return { cause: SKIP_CAUSE.invalidRecord, lostKey: id, day: null };
    if (entryDay === null) return { cause: SKIP_CAUSE.unusableTime, lostKey: id, day: null };
    return { id, record, day: entryDay };
  };

  /**
   * EXACT, NON-MULTIPLYING accounting for every row this exporter refuses.
   *
   * THE RULE, stated once: a refused row is attributed to a day IFF its `record.time` resolves to that
   * day. A row refused for an unusable record/time names no day and lands in `unattributable` instead;
   * a row refused for its ID alone is still charged to its day. Consequences, both deliberate:
   *   · no row is counted twice at any level (the defect that made `skippedInvalid` useless — it
   *     accumulated per day, so one bad row became N);
   *   · `lostIds` = (Σ per-day unique lost) + (unattributable unique lost), EXACTLY, and `skipCauses`
   *     counts each refusing row once.
   *
   * THE IDS THEMSELVES NEVER LEAVE THIS FUNCTION. Only `size` and the closed cause tokens do — the same
   * discipline `failureCodeOf` applies to a `JSON.parse` message that quotes its input.
   */
  const accountingFor = (entries) => {
    const byDay = new Map();
    const byDayCauses = new Map();
    const unattributable = new Set();
    const causes = {};
    let unidentified = 0;
    for (const entry of entries) {
      const shape = shapeOf(entry);
      if (shape.cause === undefined) continue;
      causes[shape.cause] = (causes[shape.cause] ?? 0) + 1;
      if (shape.lostKey === null) {
        // Distinct-COUNT is impossible without an identity, so these are counted separately rather than
        // silently dropped — otherwise `lostIds` would undercount "rows we refused".
        unidentified += 1;
        continue;
      }
      if (shape.day === null) { unattributable.add(shape.lostKey); continue; }
      if (!byDay.has(shape.day)) byDay.set(shape.day, new Set());
      byDay.get(shape.day).add(shape.lostKey);
      // Cause counts are per ROW (not per unique id): "how many rows were refused, and why" is the
      // question this map answers, and two rows sharing one id are still two refusals.
      if (!byDayCauses.has(shape.day)) byDayCauses.set(shape.day, {});
      const bucket = byDayCauses.get(shape.day);
      bucket[shape.cause] = (bucket[shape.cause] ?? 0) + 1;
    }
    return { byDay, byDayCauses, unattributable, causes, unidentified };
  };

  /** Σ of the sizes of a Map of Sets — the unique-lost count across days, added up exactly once. */
  const sumSetSizes = (map) => {
    let total = 0;
    for (const set of map.values()) total += set.size;
    return total;
  };

  /** Did ANY day report that it could not be assessed? (`unknown` outranks `incomplete`.) */
  const anyDayUnknown = (perDay) => Object.keys(perDay).some(
    (day) => perDay[day] && perDay[day].complete === COMPLETENESS.unknown,
  );

  /** One day's slice of the accounting: its unique lost count, its cause counts, and its verdict. */
  const dayAccount = (account, day) => {
    const lost = account.byDay.get(day);
    const causes = account.byDayCauses.get(day);
    const lostIds = lost === undefined ? 0 : lost.size;
    return Object.freeze({
      lostIds,
      skipCauses: Object.freeze(causes === undefined ? {} : { ...causes }),
      complete: lostIds === 0 ? COMPLETENESS.complete : COMPLETENESS.incomplete,
    });
  };

  /**
   * The export representation of a candidate, computed once and used for BOTH compare and append.
   *
   * Returns `{ row }` or `{ error }`. A source row that `formatAuditRecord` REFUSES is a source-side
   * problem, and it must be reported like any other per-day failure — NOT thrown out of the whole run.
   * Measured before this: a store holding one valid row plus one `content: 42` row made `exportAll`
   * (and `status`) throw `invalid audit record` while the day file already held the first row, so the
   * caller lost both the progress and the reason.
   *
   * The message carries a FIXED field-category hint and never the offending value or record content.
   */
  const projectionOf = (candidate) => {
    try {
      return { row: projectRow(candidate.record, candidate.auditId) };
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      // Only a recognised validation failure is described as such; anything else keeps its own text
      // (it may be an I/O or programming error and hiding it would be worse).
      const category = /audit record/i.test(message) ? 'source row rejected by formatAuditRecord' : name;
      return { error: `${category}: ${message}`.slice(0, 200) };
    }
  };

  /**
   * Export the rows belonging to ONE Beijing day from an ALREADY-TAKEN snapshot.
   *
   * `entries` is passed in (not re-read) so `exportAll` can process every day from one snapshot.
   */
  function exportDayFrom(entries, day, account) {
    if (!isDayName(`${day}.jsonl`)) throw new TypeError(`invalid audit day: ${String(day)}`);
    // THIS DAY's completeness, taken from the run-level accounting computed ONCE by the caller. Every
    // return below carries it, so no caller has to recompute "what did this day lose" from a counter
    // that multiplies by day.
    const dayPart = dayAccount(account, day);

    // EXPIRED DAYS ARE NEVER CREATED. This is the whole point of requiring a clock: without it the
    // exporter re-generated a pruned file (measured `secondExported:1, fileExists:true` after prune).
    if (!isLiveDay(day)) {
      // COUNT ONLY THE ROWS THAT BELONG TO THIS EXPIRED DAY. `entries.length` was the whole snapshot,
      // so every expired day multiplied the total: measured 3 source rows on two expired days plus one
      // live day reported `skippedExpired: 6` instead of 2. The per-day report has to describe THIS day.
      //
      // Reuses `classify`, i.e. exactly the same day/validity rules the normal path uses, so the
      // retention policy is untouched — only the counter is corrected.
      let expiredHere = 0;
      for (const entry of entries) {
        const classified = classify(entry, day);
        if (classified.skip === 'other-day' || classified.skip === 'invalid') continue;
        expiredHere += 1;
      }
      return Object.freeze({
        ...EMPTY_DAY,
        ...dayPart,
        exported: 0,
        alreadyPresent: 0,
        corruptLines: 0,
        skippedInvalid: 0,
        skippedOtherDay: 0,
        skippedExpired: expiredHere,
        skippedExpiredDay: true,
        failed: false,
        lastDeliveredId: null,
        lastDeliveredDay: null,
      });
    }

    // READING THE DAY FILE CAN FAIL (EACCES / EBUSY / a locked file). Before this fix that throw escaped
    // `exportDay`, so `exportAll` lost the report for the days that had already succeeded. A read
    // failure is a per-day failure, so it is reported as one.
    let delivered;
    let corruptLines;
    let fileConflicts;
    try {
      ({ delivered, corruptLines, conflicts: fileConflicts } = scanDelivered(jsonl.read(day)));
    } catch (error) {
      return Object.freeze({
        ...EMPTY_DAY,
        ...dayPart,
        exported: 0,
        alreadyPresent: 0,
        corruptLines: 0,
        skippedInvalid: 0,
        skippedOtherDay: 0,
        skippedExpired: 0,
        failed: true,
        // `unknown`, NOT `incomplete`: the day file could not be READ, so "already delivered" is
        // undetermined. `incomplete` would claim we enumerated the loss, which needs that read.
        complete: COMPLETENESS.unknown,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        failureCode: failureCodeOf(error),
        failedDay: day,
        lastDeliveredId: null,
        lastDeliveredDay: null,
      });
    }

    if (fileConflicts.length > 0) {
      // The FILE contradicts itself about one identity. Refuse the day instead of choosing a winner.
      return Object.freeze({
        ...EMPTY_DAY,
        ...dayPart,
        exported: 0,
        alreadyPresent: 0,
        corruptLines,
        skippedInvalid: 0,
        skippedOtherDay: 0,
        skippedExpired: 0,
        failed: true,
        // Same reasoning as the read-failure branch: the file disagrees with itself about an identity,
        // so which lines count as delivered is not knowable. `unknown`, never `incomplete`.
        complete: COMPLETENESS.unknown,
        error: `conflicting duplicate auditId in ${day}.jsonl: ${fileConflicts[0].auditId}`,
        failureCode: FAILURE_CODE.DAY_FILE_CONFLICT,
        failedAuditId: fileConflicts[0].auditId,
        failedDay: day,
        lastDeliveredId: null,
        lastDeliveredDay: null,
      });
    }

    let exported = 0;
    let alreadyPresent = 0;
    let skippedInvalid = 0;
    let skippedOtherDay = 0;
    let skippedExpired = 0;
    let lastDeliveredId = null;
    let lastDeliveredDay = null;
    const seenInRun = new Map();

    for (const entry of entries) {
      const classified = classify(entry, day);
      if (classified.skip === 'other-day') { skippedOtherDay += 1; continue; }
      if (classified.skip === 'invalid') { skippedInvalid += 1; continue; }
      const candidate = classified.candidate;
      if (!isLiveDay(candidate.day)) { skippedExpired += 1; continue; }

      const projected = projectionOf(candidate);
      if (projected.error !== undefined) {
        // A SOURCE ROW THE FORMATTER REFUSES. Reported as a failed day (with the identity), the rows
        // already written this run kept in `exported`, and processing stopped — exactly the same
        // contract the append path already had. Nothing is repaired or overwritten.
        return Object.freeze({
          ...EMPTY_DAY,
        ...dayPart,
          exported,
          alreadyPresent,
          corruptLines,
          skippedInvalid,
          skippedOtherDay,
          skippedExpired,
          failed: true,
          error: projected.error,
          failureCode: FAILURE_CODE.SOURCE_ROW_REJECTED,
          failedAuditId: candidate.auditId,
          failedDay: day,
          lastDeliveredId,
          lastDeliveredDay,
        });
      }
      const expected = projected.row;

      // TWO SOURCE ROWS WITH THE SAME ID BUT DIFFERENT CONTENT. The store is corrupt; appending one of
      // them (or silently counting one as already-present) would make the file disagree with SQLite
      // without saying so. Refuse and report.
      const earlier = seenInRun.get(candidate.auditId);
      if (earlier !== undefined) {
        const field = firstDifference(earlier, expected);
        if (field !== null) {
          return Object.freeze({
            ...EMPTY_DAY,
        ...dayPart,
            exported,
            alreadyPresent,
            corruptLines,
            skippedInvalid,
            skippedOtherDay,
            skippedExpired,
            failed: true,
            error: `conflicting source rows for ${candidate.auditId} (field ${field})`,
            failureCode: FAILURE_CODE.SOURCE_ROWS_CONFLICT,
            failedAuditId: candidate.auditId,
            lastDeliveredId,
            lastDeliveredDay,
          });
        }
        alreadyPresent += 1;
        continue;
      }
      seenInRun.set(candidate.auditId, expected);

      const onDisk = delivered.get(candidate.auditId);
      if (onDisk !== undefined) {
        const field = firstDifference(expected, onDisk);
        if (field === null) { alreadyPresent += 1; continue; }
        // AN IDENTITY THAT EXISTS BUT DOES NOT MATCH IS A CONFLICT, NOT A DELIVERY. Measured: a complete
        // but different row with the same auditId was reported `alreadyPresent` while the authoritative
        // SQLite content had never been exported. We neither overwrite the file nor claim success.
        return Object.freeze({
          ...EMPTY_DAY,
        ...dayPart,
          exported,
          alreadyPresent,
          corruptLines,
          skippedInvalid,
          skippedOtherDay,
          skippedExpired,
          failed: true,
          error: `conflicting export for ${candidate.auditId} (field ${field})`,
          failureCode: FAILURE_CODE.EXPORT_CONFLICT,
          failedAuditId: candidate.auditId,
          failedDay: day,
          lastDeliveredId,
          lastDeliveredDay,
        });
      }

      try {
        // The append receives the SAME projection that was just compared, so what lands is exactly what
        // was checked — not a re-derivation from a mutable source object.
        jsonl.append(candidate.record, {
          previouslyRedacted: candidate.record.redacted === true,
          auditId: candidate.auditId,
        });
      } catch (error) {
        // FAIL VISIBLY AND STOP. The failed row is NOT counted as delivered, and neither are the rows
        // after it — we stop at the first failure so `exported` means "rows actually on disk now".
        return Object.freeze({
          ...EMPTY_DAY,
        ...dayPart,
          exported,
          alreadyPresent,
          corruptLines,
          skippedInvalid,
          skippedOtherDay,
          skippedExpired,
          failed: true,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          failureCode: failureCodeOf(error),
          failedAuditId: candidate.auditId,
          failedDay: day,
          lastDeliveredId,
          lastDeliveredDay,
        });
      }
      exported += 1;
      lastDeliveredId = candidate.auditId;
      lastDeliveredDay = day;
    }

    return Object.freeze({
      // `dayPart` FIRST so an explicit per-day count can never be shadowed by the defaults, and the
      // completeness verdict is present on EVERY path — including this, the clean one.
      ...dayPart,
      exported,
      alreadyPresent,
      corruptLines,
      skippedInvalid,
      skippedOtherDay,
      skippedExpired,
      failed: false,
      lastDeliveredId,
      lastDeliveredDay,
    });
  }

  /** Export ONE day. Takes its own single snapshot, so a lone call is also snapshot-consistent. */
  function exportDay(day) {
    // The accounting is taken from THIS snapshot, the same one the export walks — so a day's verdict
    // and its rows can never come from two different moments.
    const entries = snapshot();
    return exportDayFrom(entries, day, accountingFor(entries));
  }

  /** Beijing days mentioned by a snapshot, sorted ascending. */
  const daysOf = (entries) => {
    const seen = new Set();
    for (const entry of entries) {
      const record = entry && typeof entry === 'object' ? entry.record : undefined;
      if (!record || typeof record !== 'object') continue;
      const day = dayOf(record.time);
      if (day === null) continue;     // unusable timestamp: not a day this exporter can serve
      seen.add(day);
    }
    return Object.freeze([...seen].sort());
  };

  /** Beijing days that the store's audit array currently mentions, sorted ascending. */
  function days() {
    return daysOf(snapshot());
  }

  /**
   * Export every day the store mentions, from ONE snapshot taken at entry.
   *
   * Per-day results are returned alongside the totals so a failure on one day does not hide the success
   * of another — and `failed` is true if ANY day failed.
   */
  function exportAll() {
    const perDay = {};
    let exported = 0;
    let alreadyPresent = 0;
    let corruptLines = 0;
    let skippedInvalid = 0;
    let skippedOtherDay = 0;
    let skippedExpired = 0;
    let failed = false;
    let error;
    let failedDay;
    let failedAuditId;
    let lastDeliveredId = null;
    let lastDeliveredDay = null;

    let entries;
    try {
      entries = snapshot();
    } catch (caught) {
      // A store that cannot be read is reported, not thrown: the caller must still learn that the run
      // produced nothing, and why. The verdict is `unknown` — with no snapshot there is nothing to
      // account for, and "incomplete" would claim we enumerated a loss we never looked at.
      return Object.freeze({
        ...EMPTY_DAY,
        complete: COMPLETENESS.unknown,
        exported: 0,
        alreadyPresent: 0,
        corruptLines: 0,
        skippedInvalid: 0,
        skippedOtherDay: 0,
        skippedExpired: 0,
        failed: true,
        error: caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught),
        failureCode: failureCodeOf(caught),
        perDay: Object.freeze({}),
        lastDeliveredId: null,
        lastDeliveredDay: null,
      });
    }

    // ONE accounting pass for the whole snapshot, shared by every day: that is what makes
    // `lostIds` (unique rows) and the per-day numbers add up instead of multiplying.
    const account = accountingFor(entries);

    for (const day of daysOf(entries)) {
      const result = exportDayFrom(entries, day, account);
      perDay[day] = result;
      exported += result.exported;
      alreadyPresent += result.alreadyPresent;
      corruptLines += result.corruptLines;
      skippedInvalid += result.skippedInvalid;
      skippedOtherDay += result.skippedOtherDay;
      skippedExpired += result.skippedExpired;
      if (result.lastDeliveredId !== null) lastDeliveredId = result.lastDeliveredId;
      if (result.lastDeliveredDay !== null) lastDeliveredDay = result.lastDeliveredDay;
      if (result.failed) {
        failed = true;
        // The per-day detail must not be dropped at the top level: a caller that reads only the
        // summary still has to learn WHY the run stopped, not just that it did.
        if (typeof result.error === 'string') error = result.error;
        if (typeof result.failedAuditId === 'string') failedAuditId = result.failedAuditId;
        failedDay = day;
        // Stop after the first failing day, for the same reason exportDay stops at the first failing
        // row: "the rest is not on disk", so continuing would only make the counts harder to trust.
        break;
      }
    }

    // ── THE RUN-LEVEL VERDICT ────────────────────────────────────────────────────────────────
    // `failed` keeps its existing meaning ("a day was interrupted"); `complete` answers the OTHER
    // question ("is the projection whole"), and it is derived from the accounting, never from counters
    // that multiply per day. A run that stopped at a failing day can only speak for the days it walked,
    // so it reports `incomplete` whenever anything was lost and `unknown` when a day could not be read
    // (the per-day entry carries the same verdict, and `perDay` is the detail).
    const lostIds = sumSetSizes(account.byDay) + account.unattributable.size;
    const unidentified = account.unidentified;
    let complete;
    if (unidentified > 0) {
      // Rows we could not even identify: we know they exist and are not exported, so this is NOT
      // "complete", but the loss cannot be counted as distinct ids either. Report it as a loss.
      complete = COMPLETENESS.incomplete;
    } else if (anyDayUnknown(perDay)) {
      complete = COMPLETENESS.unknown;
    } else {
      complete = lostIds === 0 ? COMPLETENESS.complete : COMPLETENESS.incomplete;
    }
    return Object.freeze({
      exported, alreadyPresent, corruptLines, skippedInvalid, skippedOtherDay, skippedExpired, failed, perDay,
      complete,
      lostIds,
      lostUnidentified: unidentified,
      skipCauses: Object.freeze({ ...account.causes }),
      ...(error === undefined ? {} : { error }),
      ...(failedDay === undefined ? {} : { failedDay }),
      ...(failedAuditId === undefined ? {} : { failedAuditId }),
      lastDeliveredId, lastDeliveredDay,
    });
  }

  /**
   * Read-only summary: how much of the store is already on disk, and where the files are. Performs NO
   * writes. `pending` is computed from the same identity+content comparison the exporter uses, so it is
   * the number `exportAll()` would try to append. Takes ONE snapshot, like the other entry points.
   */
  function status() {
    const perDay = {};
    let pending = 0;
    let deliveredTotal = 0;
    let corruptLines = 0;
    let conflicted = 0;
    let expired = 0;
    let invalid = 0;
    let failed = false;
    let error;
    let statusFailureCode;

    let entriesNow;
    try {
      entriesNow = snapshot();
    } catch (caught) {
      return Object.freeze({
        pending: 0, delivered: 0, corruptLines: 0, conflicted: 0, expired: 0,
        perDay: Object.freeze({}),
        failed: true,
        error: caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught),
        failureCode: failureCodeOf(caught),
      });
    }

    // The SAME accounting the exporter uses, for the same reason: a status probe that reports
    // "nothing pending" while rows are silently unprojectable is the exact lie this change removes.
    const account = accountingFor(entriesNow);

    for (const day of daysOf(entriesNow)) {
      const live = isLiveDay(day);
      const dayPart = dayAccount(account, day);
      // A read failure here must not make `status()` throw: a status probe that dies cannot report
      // anything, and `status()` is the ONLY way an operator finds out something is wrong.
      let delivered = new Map();
      let corrupt = 0;
      let fileConflicts = [];
      let readable = true;
      let readError = null;
      let readFailureCode = null;
      if (live) {
        try {
          ({ delivered, corruptLines: corrupt, conflicts: fileConflicts } = scanDelivered(jsonl.read(day)));
        } catch (caught) {
          readable = false;
          readError = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
          readFailureCode = failureCodeOf(caught);
        }
      }
      let pendingThisDay = 0;
      let deliveredThisDay = 0;
      let conflictedThisDay = 0;
      let expiredThisDay = 0;
      let invalidThisDay = 0;
      let firstInvalidError = null;
      let firstInvalidAuditId = null;
      for (const entry of entriesNow) {
        const classified = classify(entry, day);
        if (classified.skip !== undefined) continue;
        const { candidate } = classified;
        if (!live) { expiredThisDay += 1; continue; }
        const projected = projectionOf(candidate);
        if (projected.error !== undefined) {
          // A bad source row makes the day's status UNAVAILABLE rather than "healthy and empty".
          invalidThisDay += 1;
          if (firstInvalidError === null) {
            firstInvalidError = projected.error;
            firstInvalidAuditId = candidate.auditId;
          }
          continue;
        }
        const expected = projected.row;
        const onDisk = delivered.get(candidate.auditId);
        if (onDisk === undefined) {
          if (readable) pendingThisDay += 1;
          continue;
        }
        if (firstDifference(expected, onDisk) === null) deliveredThisDay += 1;
        else conflictedThisDay += 1;
      }
      perDay[day] = Object.freeze({
        pending: pendingThisDay,
        delivered: deliveredThisDay,
        corruptLines: corrupt,
        conflicted: conflictedThisDay,
        expired: expiredThisDay,
        invalid: invalidThisDay,
        // `invalid` above counts only rows the FORMATTER refuses (a projection failure). Rows refused for
        // their ID never reached that stage, so before this field existed they were invisible here even
        // though `exportAll` skipped them. `lostIds` + `skipCauses` are the honest counterpart.
        lostIds: dayPart.lostIds,
        skipCauses: dayPart.skipCauses,
        complete: dayPart.complete,
        ...(live ? {} : { live: false }),
        ...(readable ? {} : { failed: true, error: readError, failureCode: readFailureCode ?? 'internal-error' }),
        ...(firstInvalidError === null ? {}
          : { failed: true, error: firstInvalidError, failureCode: FAILURE_CODE.SOURCE_ROW_REJECTED, failedAuditId: firstInvalidAuditId }),
        ...(fileConflicts.length > 0 ? { conflictedIdentities: Object.freeze(fileConflicts.map((c) => c.auditId)) } : {}),
      });
      if (!readable || fileConflicts.length > 0 || firstInvalidError !== null) {
        failed = true;
        if (readError) { error = readError; statusFailureCode = readFailureCode ?? 'internal-error'; }
        else if (firstInvalidError !== null && error === undefined) {
          error = firstInvalidError;
          statusFailureCode = FAILURE_CODE.SOURCE_ROW_REJECTED;
        }
      }
      pending += pendingThisDay;
      deliveredTotal += deliveredThisDay;
      corruptLines += corrupt;
      conflicted += conflictedThisDay;
      expired += expiredThisDay;
      invalid += invalidThisDay;
    }
    // `complete` / `lostIds` / `skipCauses` mirror `exportAll` exactly, so the answer to "is the
    // projection whole" does not depend on which entry point the operator happened to call. `status()`
    // writes nothing, so `pending` stays "what exportAll would try", not "what it achieved".
    const lostIds = sumSetSizes(account.byDay) + account.unattributable.size;
    let complete;
    if (account.unidentified > 0) complete = COMPLETENESS.incomplete;
    else if (anyDayUnknown(perDay)) complete = COMPLETENESS.unknown;
    else complete = lostIds === 0 ? COMPLETENESS.complete : COMPLETENESS.incomplete;
    return Object.freeze({
      pending, delivered: deliveredTotal, corruptLines, conflicted, expired, invalid, perDay,
      complete,
      lostIds,
      lostUnidentified: account.unidentified,
      skipCauses: Object.freeze({ ...account.causes }),
      ...(failed ? { failed: true } : {}),
      ...(error === undefined ? {} : { error }),
      ...(statusFailureCode === undefined ? {} : { failureCode: statusFailureCode }),
    });
  }

  /**
   * WHICH SINKS THIS EXPORTER COVERS — a claim, in code, so it cannot drift from behaviour.
   *
   * `covers` is a closed declaration, not a promise about the future:
   *   · `audit`      → yes. The rows come from `store.read().audit` (`snapshot`, above).
   *   · `writeAudit` → NO. `state.writeAudit` is a DIFFERENT sink with a DIFFERENT row shape
   *     (`recordWrite` in qzone-write-audit-offline.mjs, keyed by `authorizationId`+stage, deliberately
   *     carrying no `content`), and it has never been read here. Reporting it as "exported" would be a
   *     fabricated claim; `uncovered` names it so a caller can say "not covered" instead of assuming
   *     silence means "nothing to export". `/audit` (qzone-console-gateway.mjs:150-174) reads BOTH,
   *     which is exactly why the difference has to be stated rather than inferred.
   */
  function coverage() {
    return Object.freeze({
      covers: Object.freeze(['audit']),
      uncovered: Object.freeze(['writeAudit']),
    });
  }

  return Object.freeze({ exportDay, exportAll, days, status, coverage });
}


export { DAY_FILE as _DAY_FILE, AUDIT_ID as _AUDIT_ID };
