import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

// Offline integration: real ledger, bindings, reader, reservations and SQLite;
// only the external platform and per-request host scope lookups are fakes.
const NOW = Date.parse('2026-11-15T04:00:00Z');
const OLD = NOW - 30 * 86400000;
const post = (id = 'p1', author = '456') => ({ author, id, time: OLD, content: `body-${id}` });
// t29: the OneBot projection now carries `images`; expectations must include it.
const withImages = (row) => ({ ...row, images: [] });
const initial = (overrides = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
  reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
  browseDay: '2026-11-15', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
  activeStart: 0, activeEnd: 1439, audit: [], grants: {},
  ledger: { day: '2026-11-15', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, ...overrides,
});
const grant = (postId = 'p1') => ({ requester: '456', author: '456', question: 'question-1', postId, status: 'ready' });

async function fixture(t, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-reader-scopes-'));
  const file = join(dir, 'state.db');
  const db = openOfflineStore(file, initial(opts.state));
  const handles = [db];
  t.after(async () => { for (const handle of handles) handle.close(); await rm(dir, { recursive: true, force: true }); });
  const ledger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'source-1' });
  ledger.registerBridgeRequest({ requestId: 'request-1', origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: 's1', turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'request-1' } }] });
  const calls = [], contexts = [], scopes = [], finished = [];
  const live = { scope: true, source: true, epoch: 8 };
  // t47: the default kind is `shared` — the surviving exception for "someone shared THIS post with
  // the operator". `admin` no longer exists as a scope kind, so a fixture defaulted to it would
  // fail validation before any of these tests reached their subject.
  //
  // `postId` is defaulted ONLY when the caller did not mention it: `shared` requires a non-null
  // postId, while the `own-history` cases below deliberately omit it and name `postIds` instead.
  // Checking `Object.hasOwn` (rather than nullish coalescing) keeps an explicit `postId: null`
  // explicit, which is what makes the "no postId on a shared scope is invalid" case testable.
  const buildScope = (context) => {
    const base = { kind: 'shared', readId: context.readId, requester: '999',
      author: String(context.targetQq), postId: null, commentId: null, grantId: null, question: null,
      ...opts.scope };
    if (!Object.hasOwn(opts.scope ?? {}, 'postId') && base.kind === 'shared') base.postId = 'p1';
    return base;
  };
  const host = {
    adminQq: '999',
    resolveScope: async (context) => {
      contexts.push(context);
      const scope = opts.resolve ? await opts.resolve(context, buildScope(context)) : buildScope(context);
      scopes.push(scope); return scope;
    },
    isScopeCurrent: () => live.scope,
    finishScope: (context, scope) => { finished.push({ context, scope }); },
    ...opts.host,
  };
  const options = {
    store: db, botQq: 123, sourceEpoch: 'source-1', getConnectionEpoch: () => live.epoch,
    authorizeSource: (c) => live.source && ledger.ownsConsumption(c), getBridgeSessions: () => ledger,
    clock: () => NOW, mode: 'read-only',
    call: async (action, params) => {
      calls.push({ action, params });
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: opts.friend ? [{ user_id: 456 }] : [] };
      if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: {
        total: 999, msglist: (opts.posts ?? [post(), post('p2')]).map(p => ({ tid: p.id, time: p.time / 1000, content: p.content })),
      } };
      // t43: the assembled runtime now wires `get_qzone_msg_detail`, so a plain-comments read
      // reaches the platform. Without a case here the fixture threw `unexpected platform action`,
      // which the reader correctly classified as `unknown` — a fixture gap, not a product result.
      if (action === 'get_qzone_msg_detail') return { status: 'ok', retcode: 0, data: {
        tid: String(params?.tid ?? 'p1'), content: 'post', comment_num: 1,
        comments: [{ comment_id: 'c1', uin: 456, name: 'n', time: Math.floor((NOW - 60000) / 1000),
          content: 'hello', replies: [] }],
      } };
      throw new Error('unexpected platform action');
    },
    ...(opts.unconfigured ? {} : { exceptionReads: host }),
  };
  const runtime = createQzoneRuntime(options);
  function dispatch(callId = 'c1', action = 'read_posts', input = { target_uin: 456 }, rt = runtime) {
    ledger.observeToolCall({ sessionId: 's1', event: { type: 'tool/call', data: { turn: 1, step: 1, callId } } });
    return rt.dispatch(action, input, { sessionId: 's1', callId });
  }
  return { db, calls, live, ledger, host, options, contexts, scopes, finished, dispatch,
    reopenRuntime() { const other = openOfflineStore(file, initial()); handles.push(other); return createQzoneRuntime({ ...options, store: other }); } };
}

test('A: an explicitly shared old nonfriend post is readable, with frozen actual call context', async t => {
  // t47: this used to dispatch under an `admin` scope and expect TWO old posts back. The admin
  // privilege was cancelled by the operator, so the only way to read a 30-day-old post now is the
  // `shared` exception — which by construction names exactly ONE post. The subject of this test
  // (the call context is frozen and captured verbatim) is unchanged; the page it reads is smaller.
  const h = await fixture(t);
  assert.deepEqual(await h.dispatch(), { ok: true, outcome: 'success', posts: [post()] });
  const context = h.contexts[0];
  assert.deepEqual({ ...context, readId: 'id' }, { account: '123', connection: 8, sourceEpoch: 'source-1',
    sessionId: 's1', requestId: 'request-1', callId: 'c1', action: 'read_posts', targetQq: 456, readId: 'id' });
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(h.finished[0].scope));
  assert.equal(h.finished.length, 1);
  assert.deepEqual(h.calls, [{ action: 'get_qzone_msg_list', params: { target_uin: 456, pos: 0, num: 20 } }]);
});

test('B: exact shared old post excludes other posts by the same author; missing target is unsupported', async t => {
  const h = await fixture(t, { scope: { kind: 'shared', requester: '777', postId: 'p1' } });
  assert.deepEqual((await h.dispatch()).posts, [post()]);
  h.scopes.length = 0;
  h.host.resolveScope = () => { throw new Error('functions must be captured'); };
  assert.deepEqual((await h.dispatch('c2')).posts, [post()]);
  const missing = await fixture(t, { scope: { kind: 'shared', requester: '777', postId: 'absent' } });
  assert.equal((await missing.dispatch()).reason, 'unsupported');
  assert.equal(Object.values(missing.db.read().readOutcomes)[0], 'unknown');
});

test('targeted A/D use a frozen semantic exact-post operation and reject malformed canonical data', async t => {
  const operations = [];
  const h = await fixture(t, { scope: { postId: 'p1' }, host: { fetchPost: (operation, guard) => {
    operations.push({ operation, current: guard(), guard }); return operations.length === 1 ? post() : { ...post(), time: NOW + 1 };
  } } });
  assert.deepEqual((await h.dispatch()).posts, [post()]);
  assert.deepEqual(operations[0].operation, { author: '456', postId: 'p1', botQq: 123, connectionEpoch: 8,
    sourceProofId: operations[0].operation.sourceProofId, readId: h.contexts[0].readId });
  assert.ok(Object.isFrozen(operations[0].operation)); assert.equal(operations[0].current, true);
  assert.equal(operations[0].guard(), false, 'a completed request cannot reuse its adapter guard');
  assert.deepEqual(await h.dispatch('c2'), { ok: true, outcome: 'unknown', posts: [] });
  assert.equal(operations[1].guard(), false);
  assert.deepEqual(h.calls, []);
});

test('C: verified new own comment returns one comment and minimal parent only', async t => {
  const operations = [];
  const h = await fixture(t, { scope: { kind: 'own-new-comment', requester: '777', postId: 'p1', commentId: 'c7',
    event: { isNew: true, selfId: '123', author: '123', postId: 'p1', commentId: 'c7' } },
    host: { fetchCommentPage: (operation, guard) => {
      operations.push(operation); assert.equal(guard(), true);
      return { status: 'ok', retcode: 0, data: { tid: 'p1', content: 'secret parent', comment_num: 90,
        comments: ['c7', 'other'].map(comment_id => ({ comment_id, uin: 777, name: 'name', time: NOW / 1000,
          content: comment_id, replies: [] })) } };
    } } });
  assert.deepEqual(await h.dispatch('c1', 'read_comments', { target_uin: 123, tid: 'p1' }), {
    ok: true, outcome: 'success', parent: { author: '123', postId: 'p1' },
    comments: [{ id: 'c7', author: '777', time: NOW, content: 'c7' }],
  });
  assert.ok(Object.isFrozen(operations[0])); assert.equal(operations[0].commentId, 'c7');
  assert.equal((await h.dispatch('c2', 'read_comments', { target_uin: 123, tid: 'wrong' })).ok, false);
  assert.equal(operations.length, 1); assert.deepEqual(h.calls, []);
  assert.equal(h.finished.length, 2);
});

test('D: grant and read intent persist before callback; a new legitimate call is denied only by consumed grant', async t => {
  let h, witnessed;
  h = await fixture(t, { state: { grants: { g1: grant() } }, scope: {
    kind: 'own-history', requester: '456', postId: 'p1', grantId: 'g1', question: 'question-1',
  }, host: { fetchPost: () => { witnessed = h.db.read(); return post(); } } });
  assert.deepEqual((await h.dispatch()).posts, [post()]);
  assert.equal(witnessed.grants.g1.status, 'consumed');
  assert.equal(Object.keys(witnessed.readAttempts).length, 1);
  assert.ok(witnessed.audit.some(e => e.id === 'grant_g1'));
  const second = await h.dispatch('different-valid-call', 'read_posts', { target_uin: 456 }, h.reopenRuntime());
  assert.equal(second.reason, 'grant');
  assert.notEqual(h.contexts[0].readId, h.contexts[1].readId);
  assert.equal(h.scopes[1].readId, h.contexts[1].readId);
  assert.equal(Object.keys(h.db.read().readAttempts).length, 1);
});

test('D: concurrent distinct real bindings on two SQLite handles dispatch only one granted fetch', async t => {
  let sends = 0;
  const h = await fixture(t, { state: { grants: { g1: grant() } }, scope: {
    kind: 'own-history', requester: '456', postId: 'p1', grantId: 'g1', question: 'question-1',
  }, host: { fetchPost: async () => { sends++; await Promise.resolve(); return post(); } } });
  const other = h.reopenRuntime();
  const results = await Promise.all([h.dispatch('one'), h.dispatch('two', 'read_posts', { target_uin: 456 }, other)]);
  assert.equal(results.filter(r => r.outcome === 'success').length, 1);
  assert.equal(results.filter(r => r.reason === 'grant').length, 1);
  assert.equal(sends, 1); assert.equal(h.contexts.length, 2);
  assert.notEqual(h.contexts[0].readId, h.contexts[1].readId);
});

test('D: throwing callback keeps grant consumed and cannot replay with fresh matching host scope', async t => {
  let sends = 0;
  const h = await fixture(t, { state: { grants: { g1: grant() } }, scope: {
    kind: 'own-history', requester: '456', postId: 'p1', grantId: 'g1', question: 'question-1',
  }, host: { fetchPost: () => { sends++; throw new Error('not sent: secret'); } } });
  assert.deepEqual(await h.dispatch(), { ok: true, outcome: 'unknown', posts: [] });
  assert.equal((await h.dispatch('fresh')).reason, 'grant');
  assert.equal(sends, 1); assert.equal(h.db.read().grants.g1.status, 'consumed');
  assert.equal(h.contexts.length, 2); assert.equal(h.finished.length, 2);
});

test('D null-post: consume null unchanged, require explicit bounded IDs and require every approved target', async t => {
  const opts = { state: { grants: { g1: grant(null) } }, scope: { kind: 'own-history', requester: '456',
    grantId: 'g1', question: 'question-1', postIds: ['p1'] } };
  const h = await fixture(t, opts);
  assert.deepEqual((await h.dispatch()).posts, [withImages(post())]);
  const intent = h.db.read().audit.find(e => e.id === 'grant_g1');
  assert.equal(intent.record.postId, null); assert.equal(h.db.read().grants.g1.status, 'consumed');
  const missing = await fixture(t, { ...opts, scope: { ...opts.scope, postIds: ['p1', 'absent'] } });
  assert.equal((await missing.dispatch()).reason, 'unsupported');
  assert.equal(missing.db.read().grants.g1.status, 'consumed');
  const unbounded = await fixture(t, { ...opts, scope: { ...opts.scope, postIds: undefined } });
  assert.equal((await unbounded.dispatch()).ok, false);
  assert.equal(unbounded.db.read().grants.g1.status, 'ready'); assert.deepEqual(unbounded.calls, []);
});

test('revoked host lease, epoch change or source end during host await releases no result', async t => {
  for (const revoke of [h => { h.live.scope = false; }, h => { h.live.epoch++; }, h => h.ledger.endTurn({ sessionId: 's1', turn: 1 })]) {
    let h;
    h = await fixture(t, { scope: { postId: 'p1' }, host: { fetchPost: async () => { await Promise.resolve(); revoke(h); return post(); } } });
    assert.deepEqual(await h.dispatch(), { ok: true, outcome: 'unknown', posts: [] });
    assert.equal(h.finished.length, 1);
    assert.equal(Object.values(h.db.read().readOutcomes)[0], 'unknown');
  }
});

test('invalid scopes, throwing resolver, getters and asynchronous predicates fail closed and finish once', async t => {
  let getterCalls = 0;
  for (const opts of [
    // t47: the old first case was `{ requester: '777' }`, invalid only because the `admin` kind
    // demanded `requester === adminQq`. That constraint left with the privilege, so the case is
    // replaced by the rule that still holds: a `shared` scope must name the post it was shared for.
    { scope: { postId: null } },
    { scope: { extra: true } },
    { resolve: () => { throw new Error('secret'); } },
    { resolve: (_c, scope) => Object.defineProperty(scope, 'author', { get() { getterCalls++; return '456'; } }) },
    { host: { isScopeCurrent: () => Promise.reject(new Error('secret')) } },
    { host: { isScopeCurrent: () => ({}) } },
  ]) {
    const h = await fixture(t, { friend: true, ...opts });
    assert.equal((await h.dispatch()).ok, false);
    assert.deepEqual(h.calls, []); assert.equal(h.finished.length, 1);
  }
  assert.equal(getterCalls, 0);
  await new Promise(resolve => setImmediate(resolve));
});

test('closed own configuration captures functions and rejects getters; model scope inputs never authorize', async t => {
  const h = await fixture(t);
  let touched = 0;
  assert.throws(() => createQzoneRuntime({ ...h.options, exceptionReads: Object.defineProperty({}, 'adminQq', {
    get() { touched++; return '999'; },
  }) }), TypeError);
  assert.equal(touched, 0);
  assert.equal((await h.dispatch('model', 'read_posts', { target_uin: 456, scope: { admin: true } })).error, 'invalid-input');
  const input = Object.defineProperty({}, 'target_uin', { get() { touched++; return 456; } });
  assert.equal((await h.dispatch('getter', 'read_posts', input)).error, 'invalid-input');
  assert.equal(touched, 0);
  assert.equal(h.contexts.length, 0); assert.deepEqual(h.calls, []);
});

test('finish failure suppresses fetched data without retry or raw errors', async t => {
  let finishes = 0, sends = 0;
  const h = await fixture(t, { scope: { postId: 'p1' }, host: {
    fetchPost: () => { sends++; return post(); },
    finishScope: () => { finishes++; throw new Error('secret'); },
  } });
  assert.deepEqual(await h.dispatch(), { ok: true, outcome: 'unknown', posts: [] });
  assert.equal(finishes, 1); assert.equal(sends, 1);
  assert.equal(Object.values(h.db.read().readOutcomes)[0], 'unknown');
  const asynchronous = await fixture(t, { scope: { postId: 'p1' }, host: {
    fetchPost: () => post(), finishScope: () => Promise.reject(new Error('secret')),
  } });
  assert.deepEqual(await asynchronous.dispatch(), { ok: true, outcome: 'unknown', posts: [] });
  assert.equal(Object.values(asynchronous.db.read().readOutcomes)[0], 'unknown');
  await new Promise(resolve => setImmediate(resolve));
  let ended, endedSends = 0, endedFinishes = 0;
  ended = await fixture(t, { state: { grants: { g1: grant() } }, scope: {
    kind: 'own-history', requester: '456', postId: 'p1', grantId: 'g1', question: 'question-1',
  }, host: {
    fetchPost: () => { endedSends++; return post(); },
    finishScope: () => { endedFinishes++; ended.live.epoch++; },
  } });
  assert.deepEqual(await ended.dispatch(), { ok: true, outcome: 'unknown', posts: [] });
  assert.equal(Object.values(ended.db.read().readOutcomes)[0], 'unknown');
  assert.equal(ended.db.read().grants.g1.status, 'consumed');
  assert.equal(endedSends, 1); assert.equal(endedFinishes, 1);
});

test('reservation denial or audit failure does not partially consume D grant or fetch', async t => {
  const h = await fixture(t, { state: { grants: { g1: grant() }, audit: null }, scope: {
    kind: 'own-history', requester: '456', postId: 'p1', grantId: 'g1', question: 'question-1',
  } });
  assert.equal((await h.dispatch()).ok, false);
  assert.equal(h.db.read().grants.g1.status, 'ready');
  assert.deepEqual(h.db.read().readAttempts, {}); assert.deepEqual(h.calls, []);
  assert.equal(h.finished.length, 1);
  const rollback = await fixture(t, { state: { grants: { g1: grant() } }, scope: {
    kind: 'own-history', requester: '456', postId: 'p1', grantId: 'g1', question: 'question-1',
  } });
  const runtime = createQzoneRuntime({ ...rollback.options, store: { ...rollback.db, update(fn) {
    return rollback.db.update(state => {
      const next = fn(state);
      if (next.grants.g1.status === 'consumed') throw new Error('transaction cannot commit');
      return next;
    });
  } } });
  assert.equal((await rollback.dispatch('rollback', 'read_posts', { target_uin: 456 }, runtime)).ok, false);
  assert.equal(rollback.db.read().grants.g1.status, 'ready');
  assert.deepEqual(rollback.db.read().readAttempts, {});
  assert.ok(!rollback.db.read().audit.some(e => e.id.startsWith('read_intent_') || e.id === 'grant_g1'));
  assert.deepEqual(rollback.calls, []);
});

test('unconfigured runtime and explicit null keep ordinary friend behavior and unwired writes', async t => {
  const h = await fixture(t, { unconfigured: true, friend: true, posts: [post(), { ...post('recent'), time: NOW }] });
  assert.deepEqual(await h.dispatch(), { ok: true, outcome: 'success', posts: [{ ...post('recent'), time: NOW }] });
  // WHAT THIS USED TO PIN: `read_comments` was refused at the TOOL GATE with
  // `tool-not-wired` on a runtime built without `exceptionReads`, because the gate
  // demanded `exceptionReads.fetchCommentPage` — an adapter no host injects.
  //
  // WHAT IT PINS NOW (t42): the gate is open for `read_comments` regardless of
  // `exceptionReads`, so the refusal can no longer come from there. The protected
  // property of THIS test is unchanged and is still asserted exactly: an
  // unconfigured runtime keeps ordinary friend reads working and keeps WRITES
  // unwired. For the read tool, what must not regress is the gate itself.
  //
  // ⚠️ THIS PASSED THROUGH A KNOWN-GAP ASSERTION AND IS NOW THE REAL SUCCESS SHAPE.
  //
  // The gap (t42): the gate was opened for `read_comments`, but `createQzoneRuntime`'s bound
  // transport injected only `get_qzone_msg_list`, so a plain-comments read (which asks for
  // `get_qzone_msg_detail`) raised the transport's not-sent marker and surfaced as
  // `read-denied / unverified` — an authorization-looking error with an unwired cause.
  // t43 wires `get_qzone_msg_detail` alongside the list method, so the read now SUCCEEDS.
  const comments = await h.dispatch('comment', 'read_comments', { target_uin: 456, tid: 'p1' });
  assert.notEqual(comments.error, 'tool-not-wired',
    'read_comments 不得再被工具闸拒绝：t42 已把 plain-comments 放进普通读路径');
  assert.equal(comments.ok, true, 'read_comments 必须真的读成功（t43 已接线 detail 传输）');
  assert.equal(comments.outcome, 'success');
  assert.equal((await h.dispatch('write', 'like', { target_uin: 456, tid: 'p1' })).error, 'write-not-wired');
  assert.deepEqual(h.contexts, []);
  // Both READ tools are wired now; writes still are not.
  assert.deepEqual(createQzoneRuntime(h.options).status().wiredTools, ['read_posts', 'read_comments']);
  const ordinary = await fixture(t, { friend: true, resolve: () => null, posts: [{ ...post(), time: NOW }] });
  assert.deepEqual((await ordinary.dispatch()).posts, [{ ...post(), time: NOW }]);
  assert.equal(ordinary.finished.length, 1); assert.equal(ordinary.finished[0].scope, null);
});
