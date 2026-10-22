// src/retry-observer.js
// Pure synchronous observer: stage detection and per-chain deduplication only.
// Cross-turn cooldown belongs to the bridge, immediately before gateway IO.
'use strict';

const RETRYABLE = new Set([503, 529]);
const THIRD = 'third';
const FINAL = 'final';
const NOTICE_TEXT = {
  third: '等一下，有点卡',
  final: '请联系管理员修复',
};

function normalizeStatus(value) {
  if (typeof value === 'number') return RETRYABLE.has(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '503' || text === '529' ? Number(text) : null;
}

function statusFromMessage(message) {
  if (typeof message !== 'string') return null;
  const text = message.trim();
  if (text.charAt(0) === '{') {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        if ('status' in parsed) return normalizeStatus(parsed.status);
        if ('statusCode' in parsed) return normalizeStatus(parsed.statusCode);
        return null;
      }
    } catch (err) {
      // not JSON: fall through to strict prefix checks
    }
  }
  const http = /^HTTP(?:\/\d+(?:\.\d+)?)?\s+(503|529)\b/i.exec(text);
  if (http) return Number(http[1]);
  const bare = /^(503|529)(?:\s|$)/.exec(text);
  return bare ? Number(bare[1]) : null;
}

export function retryHttpStatus(failure) {
  if (!failure || typeof failure !== 'object') return null;
  const raw = failure.status;
  if (raw !== undefined && raw !== null) return normalizeStatus(raw);
  if (failure.statusCode !== undefined && failure.statusCode !== null) return normalizeStatus(failure.statusCode);
  return statusFromMessage(failure.message);
}

function seqOf(event) {
  const seq = event && event.seq;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : null;
}

function emptyResult() {
  return { logs: [], notice: null, handledFinal: false };
}

function normalizeEvent(event) {
  return event?.data ? { ...event.data, type: event.type, seq: event.seq } : event;
}

export function createRetryObserver(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const maxSessions = Number.isFinite(opts.maxSessions) && opts.maxSessions >= 1
    ? Math.floor(opts.maxSessions) : 500;
  const sessions = new Map();

  function getSession(sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    if (sessions.size >= maxSessions) {
      const oldest = sessions.keys().next();
      if (!oldest.done) sessions.delete(oldest.value);
    }
    const created = { watermark: -1, current: null, chain: null };
    sessions.set(sessionId, created);
    return created;
  }

  function makeChain(turn, step, retryId) {
    return { turn, step, retryId, started: new Set(), notified: Object.create(null), hydrated: false, status: null, scheduled: 0 };
  }

  function notify(result, chain, stage, retry, terminal = false) {
    if (chain.notified[stage]) return;
    chain.notified[stage] = true;
    const log = { kind: 'notice', stage, turn: chain.turn, step: chain.step, retryId: chain.retryId };
    if (typeof retry === 'number') log.retry = retry;
    result.logs.push(log);
    result.notice = {
      text: NOTICE_TEXT[stage], stage, terminal,
      turn: chain.turn, step: chain.step, retryId: chain.retryId,
    };
  }

  function onRetry(result, session, event) {
    const current = session.current;
    if (!current || current.ended || current.turn !== event.turn) return;
    const step = event.step !== undefined && event.step !== null ? event.step : current.step;
    if (step === undefined || step === null) return;
    if (current.step !== null && current.step !== step) return;
    current.step = step;
    const retryId = event.retryId;
    if (retryId === undefined || retryId === null) return;
    let chain = session.chain;
    if (!chain || chain.turn !== current.turn || chain.step !== step || chain.retryId !== retryId) {
      chain = makeChain(current.turn, step, retryId);
      session.chain = chain;
    }
    const failure = event.failure && typeof event.failure === 'object' ? event.failure : null;
    const status = retryHttpStatus(failure);
    const retry = Number(event.retry);
    const counted = Number.isSafeInteger(retry) && retry > 0 ? retry : null;
    if (counted === null || counted <= chain.scheduled) return;
    chain.status = status;
    chain.scheduled = counted;
    if (status !== null) {
      result.logs.push({
        kind: 'scheduled', turn: chain.turn, step: chain.step,
        retryId: chain.retryId, retry: counted, status, delayMs: Number.isFinite(event.delayMs) ? event.delayMs : null,
      });
      if (counted > 1 && chain.started.has(counted - 1)) result.logs.push({ kind: 'failed', turn: chain.turn, step: chain.step, retryId: chain.retryId, retry: counted - 1, status });
    }
    if (counted === null || status === null) return;
    if (counted === 4 && chain.started.has(3)) notify(result, chain, THIRD, counted);
    if (counted === 6 && chain.started.has(5)) {
      notify(result, chain, FINAL, counted);
      result.handledFinal = true;
    }
  }

  function observe(sessionId, event) {
    const result = emptyResult();
    if (typeof sessionId !== 'string' || !event || typeof event !== 'object') return result;
    event = normalizeEvent(event);
    const session = getSession(sessionId);
    const seq = seqOf(event);
    if (seq !== null) {
      if (session.watermark >= seq) return result;
      session.watermark = seq;
    }
    const type = event.type;
    if (type === 'turn/start') {
      if (event.turn === undefined || event.turn === null) return result;
      const current = session.current;
      if (current && current.turn >= event.turn) {
        return result;
      }
      session.current = { turn: event.turn, step: null, ended: false };
      session.chain = null;
      return result;
    }
    if (type === 'step/start') {
      const current = session.current;
      if (!current || current.ended || current.turn !== event.turn) return result;
      if (event.step === undefined || event.step === null) return result;
      if (session.chain && session.chain.step !== event.step) session.chain = null;
      current.step = event.step;
      return result;
    }
    if (type === 'llm/retry') {
      onRetry(result, session, event);
      return result;
    }
    if (type === 'llm/retry-started') {
      const chain = session.chain;
      if (!chain) return result;
      if (chain.turn !== event.turn || chain.step !== event.step || chain.retryId !== event.retryId) {
        return result;
      }
      const retry = Number(event.retry);
      if (Number.isSafeInteger(retry) && retry > 0 && retry === chain.scheduled && !chain.started.has(retry)) {
        chain.started.add(retry);
        if (chain.status !== null) result.logs.push({ kind: 'started', turn: chain.turn, step: chain.step, retryId: chain.retryId, retry, status: chain.status });
      }
      return result;
    }
    if (type === 'assistant/message') {
      const chain = session.chain;
      if (!chain || chain.turn !== event.turn || chain.step !== event.step) return result;
      session.chain = null;
      if (chain.status !== null) result.logs.push({ kind: 'recovered', turn: chain.turn, step: chain.step, retryId: chain.retryId, retry: Math.max(0, ...chain.started), status: chain.status });
      return result;
    }
    if (type === 'turn/end') {
      const current = session.current;
      if (!current || current.turn !== event.turn) return result;
      current.ended = true;
      const chain = session.chain && session.chain.turn === event.turn ? session.chain : null;
      session.chain = null;
      if (!chain) return result;
      const reason = event.reason;
      const error = reason && reason.kind === 'error' && reason.error && typeof reason.error === 'object'
        ? reason.error : null;
      const status = retryHttpStatus(error);
      if (status === null) return result;
      const lastStarted = Math.max(0, ...chain.started);
      result.logs.push({ kind: 'failed', turn: chain.turn, step: chain.step, retryId: chain.retryId, retry: lastStarted, status });
      result.logs.push({ kind: 'exhausted', turn: chain.turn, step: chain.step, retryId: chain.retryId, retry: lastStarted, status });
      if (lastStarted >= 5) {
        notify(result, chain, FINAL, null, true);
        result.handledFinal = true;
      } else if (lastStarted === 3) {
        notify(result, chain, THIRD, null, true);
        result.handledFinal = true;
      }
      return result;
    }
    return result;
  }

  function hydrate(sessionId, events) {
    if (typeof sessionId !== 'string' || !Array.isArray(events)) return;
    const session = getSession(sessionId);
    const list = [];
    let maxSeq = session.watermark;
    for (let event of events) {
      if (!event || typeof event !== 'object') continue;
      event = normalizeEvent(event);
      list.push(event);
      const seq = seqOf(event);
      if (seq !== null && seq > maxSeq) maxSeq = seq;
    }
    const ordered = list.map((event, index) => ({ event, index, seq: seqOf(event) }))
      .sort((a, b) => {
        if (a.seq === null || b.seq === null) return a.index - b.index;
        return a.seq === b.seq ? a.index - b.index : a.seq - b.seq;
      });
    let open = null;
    let chain = null;
    for (const item of ordered) {
      const event = item.event;
      const type = event.type;
      if (type === 'turn/start') {
        if (event.turn === undefined || event.turn === null) continue;
        open = { turn: event.turn, step: null };
        chain = null;
        continue;
      }
      if (type === 'step/start') {
        if (!open || open.turn !== event.turn) continue;
        if (event.step === undefined || event.step === null) continue;
        if (chain && chain.step !== event.step) chain = null;
        open.step = event.step;
        continue;
      }
      if (type === 'turn/end') {
        if (open && open.turn === event.turn) {
          open = null;
          chain = null;
        }
        continue;
      }
      if (type === 'llm/retry') {
        if (!open || open.turn !== event.turn) continue;
        const step = event.step !== undefined && event.step !== null ? event.step : open.step;
        if (step === undefined || step === null) continue;
        if (open.step !== null && open.step !== step) continue;
        open.step = step;
        const retryId = event.retryId;
        if (retryId === undefined || retryId === null) continue;
        if (!chain || chain.turn !== open.turn || chain.step !== step || chain.retryId !== retryId) {
          chain = makeChain(open.turn, step, retryId);
        }
        const failure = event.failure && typeof event.failure === 'object' ? event.failure : null;
        const status = retryHttpStatus(failure);
        const retry = Number(event.retry);
        chain.status = status;
        if (Number.isSafeInteger(retry)) chain.scheduled = retry;
        if (status !== null && Number.isFinite(retry)) {
          if (retry === 4 && chain.started.has(3)) chain.notified[THIRD] = true;
          if (retry >= 6 && chain.started.has(5)) chain.notified[FINAL] = true;
        }
        continue;
      }
      if (type === 'llm/retry-started') {
        if (!chain || chain.turn !== event.turn || chain.step !== event.step
          || chain.retryId !== event.retryId) continue;
        const retry = Number(event.retry);
        if (Number.isFinite(retry)) chain.started.add(retry);
        continue;
      }
      if (type === 'assistant/message' && chain && chain.turn === event.turn
        && chain.step === event.step) {
        chain = null;
      }
    }
    session.watermark = Math.max(session.watermark, maxSeq);
    session.current = open ? { turn: open.turn, step: open.step, ended: false } : null;
    session.chain = open && chain ? chain : null;
    if (session.chain) session.chain.hydrated = true;
  }

  function forget(sessionId) {
    if (typeof sessionId !== 'string') return;
    const session = sessions.get(sessionId);
    if (!session) return;
    session.chain = null;
    session.current = null;
  }

  return { observe, hydrate, forget };
}
