import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

// Real SQLite, origin ledger and reader. Only host approval and OneBot I/O are fixtures.
const NOW = Date.parse('2026-11-15T04:00:00Z');
const initial = () => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  tools: { read_posts: true, read_comments: true, publish: true }, reads: 0, writes: 0,
  readAttempts: {}, readOutcomes: {}, notices: [], browseDay: '2026-11-15', todayBrowses: 0,
  lastBrowseAt: null, usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [],
});

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-operation-runtime-'));
  const store = openOfflineStore(path.join(dir, 'state.db'), initial());
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  if (options.initialize !== false) assert.equal(initializeReplayState(store, { now: NOW }).ok, true);
  const live = { epoch: 8, source: true, now: NOW };
  const calls = [], approvals = [];
  function build() {
    const ledger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1' });
    ledger.registerBridgeRequest({ requestId: 'request-1', origin: 'qq-inbound' });
    ledger.observeStep({ sessionId: 's1', turn: 1, step: 1,
      messages: [{ role: 'user', source: { rpcId: 'request-1' } }] });
    const runtime = createQzoneRuntime({
      store, botQq: 123, sourceEpoch: 'e1', getConnectionEpoch: () => live.epoch,
      authorizeSource: consumption => live.source && ledger.ownsConsumption(consumption),
      getBridgeSessions: () => ledger, clock: () => live.now, mode: 'enabled',
      call: async (action, params) => {
        calls.push({ action, params });
        options.onCall?.(action, store, live);
        if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
        if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
        if (action === 'get_qzone_msg_list') {
          if (options.lostResponse) throw new Error('synthetic private transport failure');
          return { status: 'ok', retcode: 0, data: { total: 1,
            msglist: [{ tid: 'p1', time: NOW / 1000 - 1, content: 'body' }] } };
        }
        throw new Error('unexpected fixture action');
      },
      operationAuthorization: {
        replayStore: options.replayStore ?? store,
        approveOperation: async operation => {
          approvals.push(operation);
          return options.approve ? options.approve(operation, store, live) : true;
        },
      },
      ...(options.exceptionReads ? { exceptionReads: options.exceptionReads } : {}),
    });
    return { runtime, ledger };
  }
  const first = build();
  function dispatch(callId = 'c1', input = { target_uin: 456 }, preconsume = false, pair = first) {
    pair.ledger.observeToolCall({ sessionId: 's1', event: { type: 'tool/call', data: { turn: 1, step: 1, callId } } });
    const binding = preconsume
      ? pair.ledger.consume({ sessionId: 's1', callId, turn: 1, step: 1 }) : null;
    return pair.runtime.dispatch(options.action ?? 'read_posts', input, { sessionId: 's1', callId, ...(binding ? { binding } : {}) });
  }
  return { store, live, calls, approvals, dispatch, build };
}

test('B3 host denial rejects before platform calls, read reservation or B2 claim', async t => {
  const f = fixture(t, { approve: () => false });
  assert.deepEqual(await f.dispatch(), { ok: false, error: 'authorization-invalid' });
  assert.deepEqual(f.calls, []);
  assert.equal(Object.keys(f.store.read().usedReadKeys).length, 0);
  assert.equal(Object.keys(f.store.read().readAttempts).length, 0);
});

test('B3 host sees frozen actual operation; caller mutation cannot change the executed target', async t => {
  const input = { target_uin: 456, num: 20 };
  const f = fixture(t, { approve: operation => {
    assert.ok(Object.isFrozen(operation)); assert.ok(Object.isFrozen(operation.input));
    assert.equal(operation.input.target_uin, 456);
    input.target_uin = 777;
    return true;
  } });
  assert.equal((await f.dispatch('c1', input)).outcome, 'success');
  const operation = f.approvals[0];
  assert.equal(operation.accountId, 123); assert.equal(operation.sessionId, 's1');
  assert.equal(operation.requestId, 'request-1'); assert.equal(operation.callId, 'c1');
  assert.equal(operation.sourceEpoch, 'e1'); assert.equal(operation.connectionEpoch, 8);
  assert.equal(operation.action, 'read_posts');
  assert.deepEqual(f.calls.find(c => c.action === 'get_qzone_msg_list').params,
    { target_uin: 456, pos: 0, num: 20 });
  assert.deepEqual(Object.keys(f.store.read().usedReadKeys), ['[123,"s1","request-1","c1"]']);
});

test('B3 both source-consumption branches require host approval without double consuming', async t => {
  const f = fixture(t);
  assert.equal((await f.dispatch('c1', { target_uin: 456 }, true)).outcome, 'success');
  assert.equal(f.approvals.length, 1);
  assert.equal(Object.keys(f.store.read().usedReadKeys).length, 1);
});

test('B3 pause or epoch change during approval prevents every platform call', async t => {
  for (const change of ['pause', 'epoch', 'source']) {
    const f = fixture(t, { approve: (_operation, store, live) => {
      if (change === 'pause') store.update(state => ({ ...state, accessPaused: true }));
      if (change === 'epoch') live.epoch++;
      if (change === 'source') live.source = false;
      return true;
    } });
    assert.equal((await f.dispatch()).error, 'authorization-invalid');
    assert.deepEqual(f.calls, []);
    assert.equal(Object.keys(f.store.read().usedReadKeys).length, 0);
  }
});

test('B3 rechecks pause between friendship I/O and list; prior claim is never reopened', async t => {
  const f = fixture(t, { onCall: (action, store) => {
    if (action === 'get_friend_list') store.update(state => ({ ...state, accessPaused: true }));
  } });
  assert.equal((await f.dispatch()).ok, false);
  assert.equal(f.calls.some(c => c.action === 'get_qzone_msg_list'), false);
  assert.equal(Object.keys(f.store.read().usedReadKeys).length, 1);
});

test('B3 committed replay claim blocks fresh-runtime replay even after lost response and changed input', async t => {
  const f = fixture(t, { lostResponse: true });
  assert.equal((await f.dispatch()).outcome, 'unknown');
  const sent = f.calls.length;
  assert.equal((await f.dispatch('c1', { target_uin: 777 }, false, f.build())).ok, false);
  assert.equal(f.calls.length, sent);
  assert.equal(Object.keys(f.store.read().usedReadKeys).length, 1);
});

test('B3 missing replay initialization or failed replay transaction cannot reach platform', async t => {
  const missing = fixture(t, { initialize: false });
  assert.equal((await missing.dispatch()).ok, false); assert.deepEqual(missing.calls, []);
  const broken = fixture(t, { replayStore: { read: () => ({}), update() { throw new Error('private store failure'); } } });
  assert.equal((await broken.dispatch()).ok, false); assert.deepEqual(broken.calls, []);
});

test('B3 semantic exception adapter also requires durable claim and a current source', async t => {
  let f, fetched = 0;
  f = fixture(t, { exceptionReads: {
    // t47：`admin` kind 已被移除，用仍然存在的 `shared`（精确分享一条）来驱动同一个语义适配器。
    adminQq: '999', resolveScope: context => ({ kind: 'shared', readId: context.readId, requester: '999',
      author: '456', postId: 'p1', commentId: null, grantId: null, question: null }),
    isScopeCurrent: () => true, finishScope: () => { f.live.source = false; },
    fetchPost: () => {
      fetched++;
      assert.equal(Object.keys(f.store.read().usedReadKeys).length, 1);
      return { author: '456', id: 'p1', time: NOW - 1, content: 'must not escape after revocation' };
    },
  } });
  assert.deepEqual(await f.dispatch(), { ok: true, outcome: 'unknown', posts: [] });
  assert.equal(fetched, 1); assert.deepEqual(f.calls, []);
});

test('B3 configured read_comments cannot bypass host denial via its semantic adapter', async t => {
  let fetched = 0;
  const f = fixture(t, { action: 'read_comments', approve: () => false, exceptionReads: {
    adminQq: '999', resolveScope: () => null, isScopeCurrent: () => true, finishScope: () => {},
    fetchCommentPage: () => { fetched++; throw new Error('must not execute'); },
  } });
  assert.deepEqual(await f.dispatch('c1', { target_uin: 123, tid: 'p1' }),
    { ok: false, error: 'authorization-invalid' });
  assert.equal(f.approvals.length, 1); assert.equal(fetched, 0); assert.deepEqual(f.calls, []);
});
