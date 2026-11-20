// Offline experiment only. Not connected to QQAgent; node:sqlite may require
// an experimental flag on supported Node versions. No platform data belongs here.
import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, realpathSync } from 'node:fs';

function encode(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      Object.getPrototypeOf(state) !== Object.prototype || typeof state.then === 'function' ||
      typeof state.toJSON === 'function') {
    throw new TypeError('state must be a synchronous plain object');
  }
  const sensitiveKeys = new Set(['cookie', 'setcookie', 'authorization', 'pskey', 'skey', 'qzonetoken',
    'accesstoken', 'refreshtoken', 'apikey', 'clientsecret', 'password', 'passwd']);
  const json = JSON.stringify(state, (key, value) => {
    if (sensitiveKeys.has(key.toLowerCase().replace(/[-_]/g, ''))) throw new TypeError('sensitive field rejected');
    return value;
  });
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('invalid state');
  return json;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// STORE AUTHORITY — the in-process identity of ONE database file
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// WHY THIS LIVES HERE AND NOT IN THE WRITE PATH
// ---------------------------------------------
// The write path keeps a PROCESS-LOCAL fault latch. Its key used to be the store OBJECT, so two
// handles opened on the same file counted as two independent send authorities and a fault latched
// through one was invisible to the other. Measured on a real temp SQLite file:
// `{sameFile:true, latchA:true, latchB:false, ok:true, transportCalls:1}` — the fault was latched and
// the message went out anyway.
//
// Only this module knows which FILE a handle is bound to, so the identity has to be minted here. A
// caller (or a model parameter) must not be able to decide it: a path string is caller-owned data and
// two spellings of one file, or two unrelated files, must not be merged or split by how they are
// spelled. Hence a TOKEN OBJECT minted from `realpathSync` of the file that was actually opened.
//
// WHAT THE TOKEN IS
// -----------------
//   · One per CANONICAL FILE PATH, shared by every handle opened on that path IN THIS PROCESS while
//     at least one of them is open (refcounted).
//   · `./x.db` and `C:\...\x.db` and `sub/../x.db` resolve to the same canonical path -> same token.
//   · Different file -> different token. Different process -> different module instance, therefore no
//     tokens at all: NOTHING here is persisted, so an in-process latch can never become
//     "cross-restart durable" by accident.
//   · Closing the LAST handle does NOT start a new authority in this process. The token is remembered
//     (`retiredByKey`, below) and re-minted AS THE SAME OBJECT when the same canonical path is opened
//     again, so a fault latched before `close()` still blocks the next write. (This bullet used to say
//     the opposite — "close + reopen starts with a NEW token and an empty latch" — which was WRONG and
//     contradicted `retiredByKey`: `close()` is a handle rotation, not a restart. Codex caught it.
//     The real memory-isolation boundary is a NEW PROCESS: a fresh module instance has no tokens and no
//     latch at all, so it must re-derive health from `state.writeGate` / `state.auditGaps` (M4 L-5).
//     An empty latch is NOT "healthy".)
//   · The token is OPAQUE: it carries no readable property, so nothing that serialises a store can
//     leak a filesystem path, and a caller cannot derive or guess a key from it.
//
// WHAT IT IS NOT: not a lock, not a durable identifier, not a second ledger, not a quota. It carries
// nothing but "which handles are the same send authority".
const authoritiesByKey = new Map();      // canonical path -> { refs, token }
const keyByToken = new WeakMap();        // token -> canonical path
const authorityByStore = new WeakMap();  // handle object -> token

// ⚠️ retiredByKey exists because "the last handle closed" is NOT "the process restarted".
//
// The registry above is refcounted: when the last handle on a file closes, its entry is dropped so the
// map does not grow without bound. But dropping the TOKEN would mint a NEW authority for the very next
// `openOfflineStore` on the same path — inside the SAME process. Measured consequence (Codex, reproduced
// in `LZ-9`): latch a fault, close the only handle, reopen the same file, and the latch is gone — the
// next write goes out. That is not L-5 ("a restart must re-derive health from the store"); it is a
// handle rotation silently laundering a process-local fault.
//
// So a token that has been released is REMEMBERED as retired and re-minted AS THE SAME OBJECT if the
// same canonical path is opened again in this process. L-5 still holds, because a real process restart
// starts from an empty module (nothing here is persisted) — see `LZ-9b`, which spawns a separate `node`
// process rather than pretending a second handle is a restart.
//
// ⚠️ AND A FAULTED AUTHORITY IS NEVER EVICTED (Codex R7 counterexample 1, reproduced in `LZ-9c`).
// The first version capped this map at 256 entries with FIFO eviction. Measured: latch a fault, close,
// open+close 257 other databases, reopen the target → `sameAuthority:false, latch:null`. The cap only
// DELAYED the defect: capacity pressure forgot a live fault and then allowed sending.
//
// The rule is now: an authority with a live process latch is PINNED (the latch module calls
// `pinAuthority` when it latches and `unpinAuthority` when it clears), and a pinned entry is never
// evicted, no matter how many other databases come and go. Eviction only ever considers UNPINNED
// entries — losing those is harmless, because an unfaulted authority has no state to lose: a fresh
// token for it changes nothing observable.
//
// ⚠️ WHAT THIS DOES *NOT* GUARANTEE (Codex R8: do not call it "tiny" or "bounded" as if proven): when
// every over-capacity candidate is pinned, this map GROWS. There is NO hard capacity bound. The size is
// however many distinct databases carry an unrecovered fault in one process, and that number is not
// something this module measures or limits — it is only bounded by how many such faults an operator
// leaves unrecovered.
//
// That is the deliberate trade: never forget an unrecovered fault. If a hard limit is ever required,
// the answer must be to REFUSE NEW ADMISSION (fail closed) rather than to drop an old fault — dropping
// one is exactly the fail-open this file exists to prevent. No capacity project is opened here.
const retiredByKey = new Map();          // canonical path -> token (re-mint as the same object)
const pinnedTokens = new WeakSet();      // tokens with a LIVE process latch: never evicted
const RETIRED_LIMIT = 256;

/** Mark an authority as carrying a live fault. A pinned authority is never evicted from the registry. */
export function pinAuthority(token) {
  if (token && typeof token === 'object') pinnedTokens.add(token);
}

/** Release that pin. Only called when the fault is genuinely cleared (controlled recovery). */
export function unpinAuthority(token) {
  if (token && typeof token === 'object') pinnedTokens.delete(token);
}

function rememberRetired(key, token) {
  retiredByKey.delete(key);              // re-insert at the end so iteration order stays LRU-ish
  retiredByKey.set(key, token);
  if (retiredByKey.size <= RETIRED_LIMIT) return;
  // Over capacity: drop the oldest UNPINNED entry. Pinned entries are skipped, never dropped.
  for (const [candidateKey, candidateToken] of retiredByKey) {
    if (candidateKey === key) continue;                       // never evict the one just remembered
    if (pinnedTokens.has(candidateToken)) continue;            // never evict a live fault
    retiredByKey.delete(candidateKey);
    if (retiredByKey.size <= RETIRED_LIMIT) return;
  }
  // Nothing evictable: grow. Losing a pinned authority would forget a live fault and then allow
  // sending, which is worse than an unbounded map.
}

function databaseKey(file) {
  // The file exists by the time this is called (it was just created or opened), so realpath resolves
  // symlinks and platform case/8.3 aliases.
  //
  // NO FALLBACK TO `String(file)` (Codex ruling). The old version did `catch { return String(file) }`,
  // which silently created a SECOND identity for a file this process is really holding open — exactly
  // the split this module exists to prevent, and it would be keyed by a caller-supplied spelling. A
  // path we cannot canonicalise is a path whose identity we cannot establish, so registration FAILS
  // (throwing) rather than inventing a key. The caller opened the file successfully, so `realpathSync`
  // failing here means something genuinely unexpected — refuse, do not guess.
  return realpathSync(file);
}

function acquireAuthority(file) {
  const key = databaseKey(file);
  const existing = authoritiesByKey.get(key);
  if (existing) { existing.refs += 1; return existing.token; }
  // Re-open in the SAME process: reuse the retired token so the latch filed under it still applies.
  const retired = retiredByKey.get(key);
  if (retired !== undefined) {
    authoritiesByKey.set(key, { refs: 1, token: retired });
    return retired;
  }
  const token = Object.freeze(Object.create(null));
  authoritiesByKey.set(key, { refs: 1, token });
  keyByToken.set(token, key);
  return token;
}

function releaseAuthority(token) {
  if (!token || typeof token !== 'object') return;
  const key = keyByToken.get(token);
  if (key === undefined) return;                  // not a token of this module
  const entry = authoritiesByKey.get(key);
  if (!entry || entry.token !== token) return;    // already released
  entry.refs -= 1;
  if (entry.refs <= 0) {
    authoritiesByKey.delete(key);
    // Keep the token object alive as the identity for this path: closing the last handle is not a
    // restart, so the in-process latch filed under it must still be reachable.
    rememberRetired(key, token);
  }
}

/** True only for a token this module minted and still holds live — a fabricated one is rejected. */
function isLiveToken(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  const key = keyByToken.get(candidate);
  if (key === undefined) return false;
  const entry = authoritiesByKey.get(key);
  return entry !== undefined && entry.token === candidate;
}

/**
 * The send authority of a store handle: a frozen token shared by every open handle on the same file,
 * or `null` when `store` was not produced by this module.
 *
 * Delegating wrappers are supported through controlled composition: spreading a handle
 * (`{ ...store, update(fn) {...} }`) copies the token as a plain own property, so a wrapper and the
 * handle it delegates to are the SAME authority. The value is re-validated against the live registry,
 * so a fabricated token is rejected and the caller falls back to plain object identity.
 *
 * @returns the authority token, or `null` for an unknown store.
 */
export function authorityOf(store) {
  if (!store || typeof store !== 'object') return null;
  const direct = authorityByStore.get(store);
  if (direct !== undefined) return direct;
  const desc = Object.getOwnPropertyDescriptor(store, 'authority');
  if (!desc || !Object.hasOwn(desc, 'value')) return null;   // accessors are never invoked
  return isLiveToken(desc.value) ? desc.value : null;
}

/**
 * Open an EXISTING state database READ-ONLY for audit export.
 *
 * ⚠️ WHY THIS EXISTS SEPARATELY FROM `openOfflineStore`
 * `openOfflineStore` is not read-only at construction time, and cannot be made so quietly: it opens
 * with `wx` to distinguish a new file from a damaged one, then runs `BEGIN IMMEDIATE` and may
 * `CREATE TABLE`/`INSERT`. An audit exporter that only calls `read()` afterwards still paid those
 * write-side steps during construction. Measured on node v24.13.0:
 *   · `new DatabaseSync(p, { readOnly: true })` reads normally;
 *   · `BEGIN IMMEDIATE` on that handle succeeds (SQLite only takes a read lock on a read-only db);
 *   · every actual write fails with `ERR_SQLITE_ERROR attempt to write a readonly database`.
 * So the read-only HANDLE is the guarantee, not our restraint about which methods we call.
 *
 * NOTHING IS CREATED. A missing file, a missing `state` table, or a missing row all throw — this
 * function never falls back to "initialise an empty database", because that would write to a path the
 * operator pointed at for reading.
 *
 * The returned handle exposes ONLY `read()` and `close()`. Deliberately no `update`: a read-only path
 * that carries a write method invites someone to use it, and `authorityOf()` would return `null` for
 * this handle anyway (it is not minted by this module's authority registry), so nothing downstream
 * could legitimately treat it as a send authority.
 *
 * @param path - path to an EXISTING SQLite file holding a `state` table with `id = 1`.
 */
export function openOfflineStoreReadOnly(path) {
  if (typeof path !== 'string' || !path) throw new TypeError('read-only store needs a path');
  // No `existsSync` pre-check race is introduced here: the DatabaseSync open below is the authority.
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state'").get();
    if (!table) throw new Error('missing state table');
    if (!db.prepare('SELECT id FROM state WHERE id = 1').get()) throw new Error('missing state');
  } catch (error) {
    db.close();
    throw error;
  }
  const read = () => {
    const row = db.prepare('SELECT value FROM state WHERE id = 1').get();
    if (!row) throw new Error('missing state');
    const state = JSON.parse(row.value);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid state');
    return state;
  };
  let closed = false;
  return Object.freeze({
    read,
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  });
}

export function openOfflineStore(path, initial) {
  const initialJson = encode(initial);
  // Exclusive creation distinguishes a new file from an existing damaged DB.
  // A crash between file creation and initialization intentionally fails closed.
  let created = false;
  try { const fd = openSync(path, 'wx'); closeSync(fd); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state'").get();
    if (!exists) {
      if (!created) throw new Error('missing state table');
      db.exec('CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL)');
      db.prepare('INSERT INTO state (id, value) VALUES (1, ?)').run(initialJson);
    } else if (!db.prepare('SELECT id FROM state WHERE id = 1').get()) {
      throw new Error('missing state');
    }
    db.exec('COMMIT');
  } catch (error) { db.close(); throw error; }
  const read = () => {
    const row = db.prepare('SELECT value FROM state WHERE id = 1').get();
    if (!row) throw new Error('missing state');
    const state = JSON.parse(row.value);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid state');
    return state;
  };
  // Minted AFTER the database is known good: a store that failed to open has no authority to share.
  const authority = acquireAuthority(path);
  let released = false;
  const handle = {
    // Deliberately an ordinary enumerable property: `{ ...store }` is the documented way to build a
    // delegating wrapper, and it must inherit the authority. See `authorityOf`.
    authority,
    read,
    update(fn) {
      if (typeof fn !== 'function') throw new TypeError('transaction callback required');
      db.exec('BEGIN IMMEDIATE');
      try {
        const next = fn(read());
        const json = encode(next);
        db.prepare('UPDATE state SET value = ? WHERE id = 1').run(json);
        db.exec('COMMIT');
        return JSON.parse(json);
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      db.close();
      if (released) return;
      released = true;
      releaseAuthority(authority);
      authorityByStore.delete(handle);
    },
  };
  authorityByStore.set(handle, authority);
  return handle;
}
