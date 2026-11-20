/**
 * Durable, event-driven quota-notice policy.
 *
 * Pure policy logic: no timers, no filesystem access and no global I/O.
 * Clock, persistence and logging are injected by the caller.
 *
 * Persisted metadata holds only opaque SHA-256 identities (of the conversation
 * key plus provider/model tuple) and primitive counters. Raw conversation keys,
 * provider/model names and error payloads are never stored.
 */
import { createHash } from 'node:crypto';

export const QUOTA_NOTICE_TEXT = '当前模型额度不足，请切换模型';
export const QUOTA_NOTICE_INTERVAL_MS = 600000;
export const QUOTA_NOTICE_LIMIT = 3;

const STATE_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 4096;
const ID_PATTERN = /^[0-9a-f]{64}$/;
const LOG_STATE_INVALID = 'quota_notice_state_invalid';
const LOG_PERSIST_FAILED = 'quota_notice_persist_failed';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identityId(key, provider, model) {
  return createHash('sha256')
    .update(JSON.stringify([key, provider, model]), 'utf8')
    .digest('hex');
}

function readIdentity(selection) {
  if (!isRecord(selection)) return null;
  try {
    const provider = selection.provider;
    const model = selection.model;
    if (!isNonEmptyString(provider) || !isNonEmptyString(model)) return null;
    return { provider, model };
  } catch {
    return null;
  }
}

function parsePersistedState(raw) {
  if (raw === null || raw === undefined) {
    return { ok: true, entries: [] };
  }
  if (!isRecord(raw)) return { ok: false };
  if (raw.version !== STATE_VERSION) return { ok: false };
  if (!Array.isArray(raw.entries)) return { ok: false };

  const seen = new Set();
  const entries = [];
  for (const candidate of raw.entries) {
    if (!isRecord(candidate)) return { ok: false };
    const { id, count, lastAt } = candidate;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return { ok: false };
    if (typeof count !== 'number' || !Number.isInteger(count)) return { ok: false };
    if (count < 0 || count > QUOTA_NOTICE_LIMIT) return { ok: false };
    if (typeof lastAt !== 'number' || !Number.isFinite(lastAt)) return { ok: false };
    if (seen.has(id)) return { ok: false };
    seen.add(id);
    if (count > 0) entries.push({ id, count, lastAt });
  }
  return { ok: true, entries };
}

export function createQuotaNotice(options = {}) {
  const opts = isRecord(options) ? options : {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const load = typeof opts.load === 'function' ? opts.load : () => null;
  const save = typeof opts.save === 'function' ? opts.save : () => {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const configuredMax = opts.maxEntries;
  const maxEntries =
    typeof configuredMax === 'number' && Number.isFinite(configuredMax) && configuredMax >= 0
      ? Math.floor(configuredMax)
      : DEFAULT_MAX_ENTRIES;

  const entries = new Map();
  const pending = new Map();
  const tickets = new WeakMap();
  let loaded = false;
  let broken = false;

  function logSafe(code) {
    try {
      log(code);
    } catch {
      /* logging failures must never reach the bridge */
    }
  }

  function currentTime() {
    try {
      const value = now();
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return value;
    } catch {
      return null;
    }
  }

  function loadState() {
    if (loaded) return;
    loaded = true;

    let raw;
    try {
      raw = load();
    } catch {
      broken = true;
      logSafe(LOG_STATE_INVALID);
      return;
    }

    let parsed;
    try { parsed = parsePersistedState(raw); }
    catch { broken = true; logSafe(LOG_STATE_INVALID); return; }
    if (!parsed.ok) {
      broken = true;
      logSafe(LOG_STATE_INVALID);
      return;
    }
    for (const entry of parsed.entries) {
      entries.set(entry.id, { id: entry.id, count: entry.count, lastAt: entry.lastAt });
    }
  }

  function persistState() {
    if (broken) return false;

    const payload = { version: STATE_VERSION, entries: [] };
    for (const entry of entries.values()) {
      payload.entries.push({ id: entry.id, count: entry.count, lastAt: entry.lastAt });
    }

    try {
      save(payload);
      return true;
    } catch {
      broken = true;
      logSafe(LOG_PERSIST_FAILED);
      return false;
    }
  }

  function reserve(key, selection) {
    if (broken) return null;
    if (!isNonEmptyString(key)) return null;

    const identity = readIdentity(selection);
    if (identity === null) return null;

    loadState();
    if (broken) return null;

    const id = identityId(key, identity.provider, identity.model);
    if (pending.has(id)) { logSafe('quota_notice_suppressed_pending'); return null; }

    const existing = entries.get(id);
    const at = currentTime();
    if (at === null) return null;

    if (existing === undefined) {
      if (entries.size >= maxEntries) { logSafe('quota_notice_suppressed_capacity'); return null; }
    } else {
      if (existing.count >= QUOTA_NOTICE_LIMIT) { logSafe('quota_notice_suppressed_limit'); return null; }
      if (at < existing.lastAt) { logSafe('quota_notice_suppressed_clock'); return null; }
      if (at - existing.lastAt < QUOTA_NOTICE_INTERVAL_MS) { logSafe('quota_notice_suppressed_cooldown'); return null; }
    }

    const hadEntry = existing !== undefined;
    const prevCount = hadEntry ? existing.count : 0;
    const prevLastAt = hadEntry ? existing.lastAt : 0;

    entries.set(id, { id, count: prevCount + 1, lastAt: at });

    const ticket = Object.freeze({});
    tickets.set(ticket, { id, active: true, hadEntry, prevCount, prevLastAt });
    pending.set(id, ticket);

    if (!persistState()) {
      pending.delete(id);
      const record = tickets.get(ticket);
      if (record !== undefined) record.active = false;
      if (hadEntry) entries.set(id, { id, count: prevCount, lastAt: prevLastAt });
      else entries.delete(id);
      return null;
    }

    return ticket;
  }

  function settle(ticket, outcome) {
    if (!isRecord(ticket)) return false;
    if (outcome !== 'sent' && outcome !== 'unknown' && outcome !== 'cancelled') return false;

    const record = tickets.get(ticket);
    if (record === undefined || !record.active) return false;

    record.active = false;
    pending.delete(record.id);

    if (outcome === 'sent' || outcome === 'unknown') {
      return true;
    }

    if (broken) return false;

    const consumed = entries.get(record.id);
    if (record.hadEntry) {
      entries.set(record.id, { id: record.id, count: record.prevCount, lastAt: record.prevLastAt });
    } else {
      entries.delete(record.id);
    }

    if (persistState()) return true;

    if (consumed !== undefined) entries.set(record.id, consumed);
    return false;
  }

  function recover(key, selection) {
    if (broken) return false;
    if (!isNonEmptyString(key)) return false;

    const identity = readIdentity(selection);
    if (identity === null) return false;

    loadState();
    if (broken) return false;

    const id = identityId(key, identity.provider, identity.model);
    const existing = entries.get(id);
    const pendingTicket = pending.get(id);
    if (existing === undefined && pendingTicket === undefined) return false;

    if (pendingTicket !== undefined) {
      const record = tickets.get(pendingTicket);
      if (record !== undefined) record.active = false;
      pending.delete(id);
    }
    entries.delete(id);

    if (!persistState()) {
      if (existing !== undefined) entries.set(id, existing);
      return false;
    }
    return true;
  }

  function isCurrent(ticket) {
    if (broken) return false;
    if (!isRecord(ticket)) return false;
    const record = tickets.get(ticket);
    if (record === undefined || !record.active) return false;
    return pending.get(record.id) === ticket;
  }

  // Write the real dispatch time before network IO; queue waiting is not cooldown.
  function begin(ticket) {
    if (!isCurrent(ticket)) return false;
    const record = tickets.get(ticket);
    if (record.begun) return false;
    const at = currentTime();
    const entry = entries.get(record.id);
    if (at === null || !entry || at < entry.lastAt) return false;
    entries.set(record.id, { ...entry, lastAt: at });
    if (!persistState()) { entries.set(record.id, entry); return false; }
    record.begun = true;
    return true;
  }

  return { reserve, begin, settle, recover, isCurrent };
}
