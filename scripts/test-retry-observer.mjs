import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../src/retry-observer.js').catch(() => null);

test('exports createRetryObserver', () => {
  assert.equal(typeof mod?.createRetryObserver, 'function');
});

const A = 'group:100', B = 'group:200', SECRET = 'secret-canary-9f3a';
const fail = (status = 529) => ({ status, code: 'SERVER', message: `${status} overloaded` });
let seq = 0;
const nxt = () => ++seq;
const ts = (turn = 1) => ({ seq: nxt(), type: 'turn/start', data: { turn } });
const ss = (turn = 1, step = 1) => ({ seq: nxt(), type: 'step/start', data: { turn, step } });
const rt = (k, failure, o = {}) => ({ seq: nxt(), type: 'llm/retry', data: { retryId: o.retryId ?? 'chain-a', turn: o.turn ?? 1, step: o.step ?? 1, retry: k, maxRetries: 5, delayMs: 500, provider: 'fixture', mode: 'normal', policyKey: 'p', failure } });
const st = (k, o = {}) => ({ seq: nxt(), type: 'llm/retry-started', data: { retryId: o.retryId ?? 'chain-a', turn: o.turn ?? 1, step: o.step ?? 1, retry: k } });
const te = (o = {}) => ({ seq: nxt(), type: 'turn/end', data: { turn: o.turn ?? 1, reason: o.reason ?? { kind: 'completed' } } });
const am = (turn = 1, step = 1) => ({ seq: nxt(), type: 'assistant/message', data: { turn, step, message: { content: [] } } });
const chain = ({ turn = 1, step = 1, to = 4, retryId = 'chain-a', failure } = {}) => {
  const f = failure ?? (() => fail());
  const out = [ts(turn), ss(turn, step)];
  for (let k = 1; k <= to; k++) {
    if (k > 1) out.push(st(k - 1, { turn, step, retryId }));
    out.push(rt(k, f(k), { turn, step, retryId }));
  }
  out.push(st(to, { turn, step, retryId }));
  return out;
};
const mk = (o = {}) => mod.createRetryObserver(o);
const drive = (obs, sid, evs) => evs.map((e) => obs.observe(sid, e));
const stage = (rs, s) => rs.map((r) => r.notice).find((x) => x && x.stage === s);
const errEnd = (turn = 1) => te({ turn, reason: { kind: 'error', error: fail() } });

test('retryHttpStatus parses explicit and message statuses', () => {
  for (const v of [{ status: 529 }, { statusCode: 529 }, { status: 503 }, { statusCode: 503 }]) {
    assert.equal(mod.retryHttpStatus(v), Object.values(v)[0]);
  }
  assert.equal(mod.retryHttpStatus({ message: '529 overloaded' }), 529);
  assert.equal(mod.retryHttpStatus({ message: 'HTTP 503 Service Unavailable' }), 503);
  assert.equal(mod.retryHttpStatus({ message: JSON.stringify({ status: 529 }) }), 529);
  assert.equal(mod.retryHttpStatus({ message: JSON.stringify({ statusCode: 503 }) }), 503);
});

test('retryHttpStatus rejects non-target or ambiguous signals', () => {
  const bad = [
    { status: 429, message: '529 overloaded' },
    { status: 502 },
    { status: 504 },
    { statusCode: 500, message: 'HTTP 503 x' },
    { message: 'SERVER overloaded' },
    { message: 'request_id=529' },
    { message: 'upstream said 529 after timeout' },
    { message: 'ok' },
    null,
    undefined,
  ];
  for (const v of bad) assert.equal(mod.retryHttpStatus(v), null);
});

test('third notice only after started3 plus explicit 529 retry4 failure', () => {
  const early = drive(mk(), A, chain({ to: 3 }));
  assert.equal(stage(early, 'third'), undefined);
  const rs = drive(mk(), A, chain({ to: 4 }));
  const notice = stage(rs, 'third');
  assert.ok(notice);
  assert.equal(notice.text, '等一下，有点卡');
  assert.deepEqual([notice.turn, notice.step, notice.retryId], [1, 1, 'chain-a']);
  assert.equal(typeof notice.text, 'string');
  assert.ok(notice.text.length > 0);
});

test('only the third and fifth failed retries emit the exact notices', () => {
  for (const status of [503, 529]) {
    const obs = mk();
    const failure = fail(status);
    assert.equal(obs.observe(A, ts()).notice, null);
    assert.equal(obs.observe(A, ss()).notice, null);
    // retry 1 is scheduled after the initial request failed; it has not failed yet.
    assert.equal(obs.observe(A, rt(1, failure)).notice, null);
    for (let retry = 1; retry <= 5; retry++) {
      assert.equal(obs.observe(A, st(retry)).notice, null);
      const result = retry < 5
        ? obs.observe(A, rt(retry + 1, failure))
        : obs.observe(A, te({ reason: { kind: 'error', error: failure } }));
      const expected = retry === 3 ? '等一下，有点卡'
        : retry === 5 ? '请联系管理员修复' : null;
      assert.equal(result.notice?.text ?? null, expected, `HTTP ${status}, failed retry ${retry}`);
    }
  }
});

test('third notice ignores non-target terminal statuses', () => {
  const rs = drive(mk(), A, chain({ to: 4, failure: (k) => (k === 4 ? fail(500) : fail()) }));
  assert.equal(stage(rs, 'third'), undefined);
});

test('final notice after started5 and 529 error turn end', () => {
  const obs = mk();
  const rs = drive(obs, A, chain({ to: 5 }));
  assert.ok(stage(rs, 'third'));
  const r = obs.observe(A, errEnd());
  assert.ok(r.notice);
  assert.equal(r.notice.stage, 'final');
  assert.equal(r.notice.text, '请联系管理员修复');
  assert.deepEqual([r.notice.turn, r.notice.step, r.notice.retryId], [1, 1, 'chain-a']);
  assert.equal(r.handledFinal, true);
});

test('assistant success clears the chain and blocks final', () => {
  const obs = mk();
  drive(obs, A, chain({ to: 5 }));
  const ok = obs.observe(A, am());
  assert.equal(ok.notice, null);
  const end = obs.observe(A, te());
  assert.equal(end.notice, null);
  assert.equal(end.handledFinal, false);
});

test('final notice rejects a 429 terminal error', () => {
  const obs = mk();
  drive(obs, A, chain({ to: 5 }));
  const end = obs.observe(A, te({ reason: { kind: 'error', error: { status: 429, code: 'RATE_LIMIT', message: '429 too many requests' } } }));
  assert.equal(end.notice, null);
  assert.equal(end.handledFinal, false);
});

test('retry chains do not span steps', () => {
  const obs = mk();
  drive(obs, A, [ts(1), ss(1, 1), rt(1, fail()), rt(2, fail()), rt(3, fail()), st(1), st(2), st(3), ss(1, 2)]);
  const r = obs.observe(A, rt(4, fail(), { turn: 1, step: 2 }));
  assert.equal(r.notice, null);
});

test('sessions and their state are isolated', () => {
  const obs = mk();
  assert.ok(stage(drive(obs, A, chain({ to: 4 })), 'third'));
  assert.ok(stage(drive(obs, B, chain({ to: 4 })), 'third'));
});

test('duplicate seq is ignored silently', () => {
  const obs = mk();
  const evs = chain({ to: 4 });
  assert.ok(stage(drive(obs, A, evs), 'third'));
  const dup = evs.find((e) => e.type === 'llm/retry' && e.data.retry === 4);
  const r = obs.observe(A, dup);
  assert.deepEqual(r.logs, []);
  assert.equal(r.notice, null);
  assert.equal(r.handledFinal, false);
});

test('hydrate is silent, closed turns stay silent, replay is blocked', () => {
  const obs = mk();
  const old = [...chain({ to: 5 }), errEnd()];
  obs.hydrate(A, old);
  for (const e of old) assert.equal(obs.observe(A, e).notice, null);
  const live = mk();
  live.hydrate(B, chain({ to: 5 }));
  const end = live.observe(B, errEnd());
  assert.equal(end.notice?.stage, 'final');
  assert.equal(end.handledFinal, true);
});

test('forget cancels pending chain state', () => {
  const obs = mk();
  drive(obs, A, chain({ to: 5 }));
  obs.forget(A);
  const end = obs.observe(A, errEnd());
  assert.equal(end.notice, null);
  assert.equal(end.handledFinal, false);
});

test('observer emits each new chain; only the sending layer owns dispatch cooldown', () => {
  const obs = mod.createRetryObserver();
  assert.ok(stage(drive(obs, A, chain({ to: 4 })), 'third'));
  obs.observe(A, te());
  assert.ok(stage(drive(obs, A, chain({ turn: 2, to: 4 })), 'third'), 'unsent earlier notice must not consume observer cooldown');
  obs.observe(A, te({ turn: 2 }));
  const again = drive(obs, A, chain({ turn: 3, to: 5 }));
  assert.ok(stage(again, 'third'));
  const end = obs.observe(A, errEnd(3));
  assert.equal(end.notice?.stage, 'final');
  assert.equal(end.handledFinal, true);
});

test('logs never expose raw failure messages', () => {
  const obs = mk();
  const secret = () => ({ status: 529, code: 'SERVER', message: `529 overloaded ${SECRET}` });
  const rs = [...drive(obs, A, chain({ to: 5, failure: secret })), obs.observe(A, te({ reason: { kind: 'error', error: secret() } }))];
  assert.ok(rs.some((r) => r.notice));
  assert.equal(JSON.stringify(rs.map((r) => r.logs)).includes(SECRET), false);
});

test('orphan events without turn/start fail closed', () => {
  const obs = mk();
  for (const r of [obs.observe(A, st(3)), obs.observe(A, rt(4, fail())), obs.observe(A, errEnd())]) {
    assert.equal(r.notice, null);
    assert.equal(r.handledFinal, false);
  }
});

test('capacity eviction drops stale pending sessions', () => {
  const obs = mod.createRetryObserver({ maxSessions: 1 });
  drive(obs, A, chain({ to: 5 }));
  drive(obs, B, chain({ to: 4 }));
  const end = obs.observe(A, errEnd());
  assert.equal(end.notice, null);
  assert.equal(end.handledFinal, false);
});

test('third retry terminal failure is confirmed only at error end', () => {
  const obs = mk();
  assert.equal(stage(drive(obs, A, chain({ to: 3 })), 'third'), undefined);
  const result = obs.observe(A, errEnd());
  assert.equal(result.notice?.text, '等一下，有点卡');
  assert.equal(result.handledFinal, true, 'terminal third-stage notice replaces the legacy error notice');
});

test('retry schedule and start logs carry the actual attempt and delay', () => {
  const rs = drive(mk(), A, chain({ to: 3 }));
  const logs = rs.flatMap(r => r.logs);
  assert.ok(logs.some(l => l.kind === 'scheduled' && l.retry === 3 && l.delayMs === 500));
  assert.ok(logs.some(l => l.kind === 'started' && l.retry === 3));
  assert.ok(logs.some(l => l.kind === 'failed' && l.retry === 2));
});
