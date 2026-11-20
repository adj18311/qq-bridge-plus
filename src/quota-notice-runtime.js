import { classifyQuotaError } from './quota-error.js';
import { QUOTA_NOTICE_TEXT } from './quota-notice.js';

const DEFAULT_MAX_SESSIONS = 256;
const DIAG_LIMIT = 500;
const CODES = Object.freeze({
  quota: 'quota_notice_quota_error', sent: 'quota_notice_sent', cancelled: 'quota_notice_cancelled',
  unknown: 'quota_notice_unknown', send: 'quota_notice_send_failed', guard: 'quota_notice_guard_error',
  policy: 'quota_notice_policy_error', enqueue: 'quota_notice_enqueue_error', state: 'quota_notice_state_error',
});

function noop() {}
function num(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function label(value) { return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null; }
function pick(value) {
  if (!value || typeof value !== 'object') return null;
  const provider = label(value.provider), model = label(value.model);
  return provider && model ? { provider, model } : null;
}
function eventSelection(data) {
  if (!data || typeof data !== 'object') return null;
  return pick(data.selection) || pick({ provider: data.provider, model: data.model });
}
function requestSelection(type, data) {
  return type === 'request/header' ? pick(data?.header?.config) : type === 'request/context' ? pick(data) : null;
}
function sameSelection(left, right) { return !!left && !!right && left.provider === right.provider && left.model === right.model; }
function sessionId(sid) {
  if (typeof sid === 'string' && sid.length > 0) return sid;
  return typeof sid === 'number' && Number.isFinite(sid) ? String(sid) : null;
}

export function createQuotaNoticeRuntime(options = {}) {
  const config = options || {};
  const { policy, getSelection, enqueue, captureGuard, send } = config;
  const log = typeof config.log === 'function' ? config.log : noop;
  const redact = typeof config.redact === 'function' ? config.redact : () => '[diagnostic-unavailable]';
  const maxSessions = config.maxSessions;
  const sessionLimit = typeof maxSessions === 'number' && Number.isFinite(maxSessions) && maxSessions >= 1
    ? Math.floor(maxSessions) : DEFAULT_MAX_SESSIONS;
  const sessions = new Map();
  function emit(code, detail) { try { if (detail === undefined) log(code); else log(code, detail); } catch { noop(); } }
  function diagnostic(failure) {
    try {
      const rendered = redact(failure);
      return (typeof rendered === 'string' ? rendered : '[diagnostic-unavailable]').replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').slice(0, DIAG_LIMIT);
    } catch { return 'redact_failed'; }
  }
  function settle(ticket, outcome) {
    if (!ticket) return;
    try { policy.settle(ticket, outcome); } catch { emit(CODES.state); }
    emit(outcome === 'sent' ? CODES.sent : outcome === 'unknown' ? CODES.unknown : CODES.cancelled);
  }
  function desired(key, sid) {
    if (typeof getSelection !== 'function') return null;
    try { return pick(getSelection(key, sid)); } catch { emit(CODES.state); return null; }
  }
  function unlink(entry, session) {
    const list = session && session.pending, index = list ? list.indexOf(entry) : -1;
    if (index !== -1) list.splice(index, 1);
  }
  function cancelEntry(entry, session) {
    if (!entry || entry.phase !== 'queued') return;
    entry.phase = 'cancelled'; unlink(entry, session); settle(entry.ticket, 'cancelled');
  }
  function finishEntry(entry, session, outcome) {
    if (!entry) return;
    entry.phase = 'settled'; unlink(entry, session); settle(entry.ticket, outcome);
  }
  function detach(session) {
    const list = session && session.pending;
    if (!list || list.length === 0) return;
    session.pending = [];
    for (const entry of list) {
      if (entry.phase === 'queued') cancelEntry(entry, session);
      else session.pending.push(entry);
    }
  }
  function drop(sid) {
    const session = sessions.get(sid);
    if (!session) return;
    detach(session);
    sessions.delete(sid);
  }
  function obtain(sid, key) {
    const existing = sessions.get(sid);
    if (existing) { existing.key = key; return existing; }
    if (sessions.size >= sessionLimit) {
      const oldest = sessions.keys().next();
      if (!oldest.done) drop(oldest.value);
    }
    const created = { sid, key, seq: null, epoch: 0, selection: null, route: null, turn: null, pending: [] };
    sessions.set(sid, created);
    return created;
  }
  function turnStart(session, key, data) {
    const turn = num(data.turn);
    if (turn === null) return;
    detach(session);
    session.epoch += 1;
    session.turn = { turn, step: num(data.step), model: eventSelection(data) || session.route || session.selection || desired(key, session.sid), done: false };
  }
  function stepStart(session, data) {
    const open = session.turn, turn = num(data.turn), step = num(data.step);
    if (!open || open.done || turn === null || step === null || turn !== open.turn) return;
    detach(session);
    session.epoch += 1;
    open.step = step;
    const actual = eventSelection(data) || session.route || session.selection;
    if (actual) open.model = actual;
  }
  function selectionChanged(session, data) {
    const next = eventSelection(data);
    if (!next) return;
    if (session.pending.some(entry => !sameSelection(entry.model, next))) detach(session);
    session.selection = next;
    // DSH commits model/selection for the NEXT request, never relabel an in-flight request.
  }
  function requestChanged(session, next) {
    session.route = next;
    if (session.pending.some(entry => !sameSelection(entry.model, next))) detach(session);
    if (session.turn && !session.turn.done) session.turn.model = next;
  }
  function queueNotice(session, key, open) {
    const model = open.model;
    if (!model || typeof enqueue !== 'function' || typeof captureGuard !== 'function' || typeof send !== 'function') return;
    if (!policy || typeof policy.reserve !== 'function' || typeof policy.isCurrent !== 'function' || typeof policy.settle !== 'function') return;
    let assert = null;
    try { assert = captureGuard(key, session.sid); } catch { emit(CODES.guard); return; }
    if (typeof assert !== 'function') return;
    try { if (assert() === false) return; } catch { emit(CODES.guard); return; }
    let ticket = null;
    try { ticket = policy.reserve(key, model); } catch { emit(CODES.policy); return; }
    if (!ticket) return;
    const entry = { ticket, key, sid: session.sid, model, turn: open, step: open.step, epoch: session.epoch, phase: 'queued' };
    session.pending.push(entry);
    try {
      const queued = enqueue(() => runEntry(entry, session, assert));
      if (queued && typeof queued.then === 'function') queued.then(noop, () => cancelEntry(entry, session));
    } catch { cancelEntry(entry, session); emit(CODES.enqueue); }
  }
  async function runEntry(entry, session, assert) {
    try {
      if (entry.phase !== 'queued') return;
      if (sessions.get(entry.sid) !== session) return cancelEntry(entry, session);
      const open = session.turn;
      if (open !== entry.turn || session.epoch !== entry.epoch || open.step !== entry.step) return cancelEntry(entry, session);
      let guarded = false;
      try { guarded = assert() !== false; } catch { guarded = false; }
      if (!guarded) return cancelEntry(entry, session);
      const current = desired(entry.key, entry.sid);
      if (!current || !sameSelection(current, entry.model)) return cancelEntry(entry, session);
      let live = false;
      try { live = policy.isCurrent(entry.ticket) === true; } catch { live = false; }
      if (!live) return cancelEntry(entry, session);
      if (typeof policy.begin !== 'function' || !policy.begin(entry.ticket)) return cancelEntry(entry, session);
      if (entry.phase !== 'queued') return;
      entry.phase = 'sending';
      try { await send(entry.key, QUOTA_NOTICE_TEXT); } catch {
        finishEntry(entry, session, 'unknown');
        emit(CODES.send);
        return;
      }
      finishEntry(entry, session, 'sent');
    } catch {
      if (entry.phase === 'sending') { finishEntry(entry, session, 'unknown'); emit(CODES.send); }
      else { emit(CODES.state); cancelEntry(entry, session); }
    }
  }
  function turnEnded(session, key, data, quota) {
    const open = session.turn, turn = num(data.turn), step = num(data.step);
    if (!open || open.done || turn === null || turn !== open.turn) return { handled: quota };
    if (!quota) {
      if (step === null || open.step === null || step === open.step) open.done = true;
      return { handled: false };
    }
    // A trusted route plus a terminal step can fill a lost step/start; never move backwards.
    if (open.step === null && !session.route) return { handled: true };
    if (step !== null && open.step !== null && step < open.step) return { handled: true };
    if (step !== null) open.step = step;
    queueNotice(session, key, open);
    open.done = true;
    return { handled: true };
  }
  function assistantSucceeded(session, key, data) {
    const open = session.turn, turn = num(data.turn), step = num(data.step);
    if (!open || open.done || turn === null || turn !== open.turn) return;
    if (data.interrupted === true) return;
    if (open.step === null && step !== null) open.step = step;
    if (open.step === null || (step !== null && step !== open.step)) return;
    const message = data.message;
    if (!message || typeof message !== 'object' || message.isError === true) return;
    if (message.role !== undefined && message.role !== 'assistant') return;
    const model = pick(message.source) || open.model;
    if (!model || !policy || typeof policy.recover !== 'function') return;
    detach(session);
    try { policy.recover(key, model); } catch { emit(CODES.policy); }
  }
  function observe(key, sid, event) {
    let quota = false;
    try {
      if (typeof key !== 'string' || key.length === 0) return { handled: false };
      const id = sessionId(sid);
      if (id === null || !event || typeof event !== 'object') return { handled: false };
      const type = label(event.type), data = event.data;
      const terminal = type === 'turn/end' && !!data && typeof data === 'object' && !!data.reason && data.reason.kind === 'error';
      if (terminal) {
        try {
          const verdict = classifyQuotaError(data.reason.error);
          quota = !!verdict && verdict.exhausted === true;
          if (quota) emit(CODES.quota, 'reason=' + String(verdict.reason) + ' diag=' + diagnostic(data.reason.error));
        } catch { quota = false; }
      }
      const seq = num(event.seq);
      if (!data || typeof data !== 'object') return { handled: quota };
      const session = obtain(id, key);
      if (seq !== null && session.seq !== null && seq <= session.seq) {
        return { handled: quota };
      }
      if (seq !== null) session.seq = seq;
      session.key = key;
      if (type === 'turn/start') turnStart(session, key, data);
      else if (type === 'step/start') stepStart(session, data);
      else if (type === 'turn/end') return turnEnded(session, key, data, quota);
      else if (type === 'assistant/message') assistantSucceeded(session, key, data);
      else if (type === 'model/selection') selectionChanged(session, data);
      else if (requestSelection(type, data)) requestChanged(session, requestSelection(type, data));
      return { handled: quota };
    } catch {
      emit(CODES.state);
      return { handled: quota };
    }
  }
  function hydrate(sid, records) {
    try {
      const id = sessionId(sid);
      if (id === null) return false;
      const session = obtain(id, '');
      detach(session);
      session.epoch += 1; session.turn = null; session.selection = null; session.route = null;
      let watermark = session.seq;
      for (const item of Array.isArray(records) ? records : []) {
        const record = item?.type === 'event' ? item.event : item;
        if (!record || typeof record !== 'object') continue;
        const seq = num(record.seq);
        if (seq !== null && (watermark === null || seq > watermark)) watermark = seq;
        const type = label(record.type), data = record.data;
        if (!data || typeof data !== 'object') continue;
        const actual = eventSelection(data), turn = num(data.turn), step = num(data.step), open = session.turn;
        if (type === 'model/selection' && actual) session.selection = actual;
        const route = requestSelection(type, data);
        if (route) requestChanged(session, route);
        if (type === 'turn/start' && turn !== null) session.turn = { turn, step, model: actual || session.route || session.selection, done: false };
        else if (type === 'step/start' && open && !open.done && turn !== null && step !== null && turn === open.turn) {
          open.step = step;
          const model = actual || session.route || session.selection;
          if (model) open.model = model;
        } else if (type === 'turn/end' && open && (turn === null || turn === open.turn)) session.turn = null;
      }
      session.seq = watermark;
      return true;
    } catch {
      emit(CODES.state);
      return false;
    }
  }
  function forget(sid) {
    const id = sessionId(sid);
    if (id !== null) drop(id);
  }
  function clear() {
    for (const sid of Array.from(sessions.keys())) drop(sid);
  }
  return { observe, hydrate, forget, clear };
}
