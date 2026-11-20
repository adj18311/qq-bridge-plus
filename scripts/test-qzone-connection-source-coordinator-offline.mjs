import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isOriginLedgerConsumption } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneConnectionSourceCoordinator } from '../src/core/qzone-connection-source-coordinator-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';

class Client extends EventEmitter {
  replies = []; calls = 0; middlewares = [];
  getLoginInfo() { this.calls++; return this.replies.shift()(); }
  ok(id = 123) { this.replies.push(() => Promise.resolve({ user_id: id })); }
  use() { return () => {}; }
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture() { const client = new Client(); const c = createQzoneConnectionSourceCoordinator({ client, expectedUserId: 123 }); return { client, c }; }
function ticket(c) {
  const l = c.getLedger('s'); l.registerBridgeRequest({ requestId: 'r', origin: 'qq-inbound' });
  assert.equal(l.observeStep({ sessionId: 's', turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'r' } }] }), true);
  assert.equal(l.observeToolCall({ sessionId: 's', event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c' } } }), true);
  return { l, value: l.consume({ sessionId: 's', turn: 1, step: 1, callId: 'c' }) };
}
async function open(f) { f.client.emit('open'); f.client.ok(); assert.equal(await f.c.verify(), true); }

test('no connection or source before explicit verified open; tracker registered first', async () => {
  const f = fixture(); assert.equal(await f.c.verify(), false); assert.equal(f.client.calls, 0);
  assert.equal(f.c.connectionEpoch(), -1); assert.equal(f.c.sourceEpoch(), null); assert.throws(() => f.c.getLedger('s'));
  await open(f); assert.equal(f.c.connectionEpoch(), 1); assert.equal(f.c.accountId(), 123);
  const t = ticket(f.c); assert.equal(f.c.ownsConsumption(t.value), true); f.c.dispose();
});

test('open close error synchronously revoke sources, including repeated events', async () => {
  for (const event of ['open', 'close', 'error']) {
    const f = fixture(); await open(f); const t = ticket(f.c); const before = f.c.sourceEpoch();
    f.client.emit(event, new Error('fixture')); assert.equal(isOriginLedgerConsumption(t.value), false);
    assert.equal(f.c.ownsConsumption(t.value), false); assert.equal(f.c.sourceEpoch(), null); assert.throws(() => f.c.getLedger('s'));
    assert.throws(() => t.l.registerBridgeRequest({ requestId: 'new', origin: 'schedule' }));
    f.client.emit(event, new Error('fixture')); if (event !== 'open') f.client.emit('open');
    f.client.ok(); assert.equal(await f.c.verify(), true); assert.notEqual(f.c.sourceEpoch(), before); f.c.dispose();
  }
});

test('conflicts and malformed events revoke synchronously and lock until new open', async () => {
  for (const event of [{ post_type: 'message', self_id: 456 }, { post_type: 'message' },
    { post_type: 'meta_event', self_id: '123' }, { post_type: 'notice', self_id: 123, notice_type: 'bot_status', sub_type: 'online', user_id: 456 },
    { post_type: 'notice', self_id: 123, notice_type: 'bot_status', sub_type: 'offline', user_id: 123 }, null]) {
    const f = fixture(); await open(f); const t = ticket(f.c); f.client.emit('event', event);
    assert.equal(isOriginLedgerConsumption(t.value), false); assert.equal(f.c.isReady(), false);
    assert.equal(await f.c.verify(), false); assert.throws(() => f.c.getLedger('s')); f.c.dispose();
  }
});

test('observeEvent checks before downstream processing, valid events keep source alive', async () => {
  const f = fixture(); await open(f); const t = ticket(f.c);
  assert.equal(f.c.observeEvent({ post_type: 'message', self_id: 123 }), true);
  assert.equal(f.c.ownsConsumption(t.value), true);
  assert.equal(f.c.observeEvent({ post_type: 'message', self_id: 999 }), false);
  assert.equal(isOriginLedgerConsumption(t.value), false); f.c.dispose();
});

test('SDK middleware 在业务回调前撤销冲突账号，同时不阻断普通 QQ 消息', async () => {
  class MiddlewareClient extends Client {
    layers = [];
    use(fn) { this.layers.push(fn); return () => { this.layers = this.layers.filter((x) => x !== fn); }; }
    async dispatch(event) { let i = -1; const next = async () => { const fn = this.layers[++i]; if (fn) await fn(event, {}, next); }; await next(); }
  }
  const client = new MiddlewareClient();
  const c = createQzoneConnectionSourceCoordinator({ client, expectedUserId: 123 });
  client.emit('open'); client.ok(); await c.verify();
  const t = ticket(c); let observed = null;
  client.use(async (_event, _ctx, next) => { observed = c.ownsConsumption(t.value); await next(); });
  await client.dispatch({ post_type: 'message', self_id: 456 });
  assert.equal(observed, false);
  assert.equal(isOriginLedgerConsumption(t.value), false);
  c.dispose();
});

test('SnowLuma SDK 真实 middleware 链在私聊回调前撤销冲突账号', async () => {
  class NeverConnect {}
  const client = new SnowLumaWebSocketClient({ webSocket: NeverConnect, reconnect: false });
  client.getLoginInfo = async () => ({ user_id: 123 });
  const c = createQzoneConnectionSourceCoordinator({ client, expectedUserId: 123 });
  client.emitter.emit('open'); assert.equal(await c.verify(), true);
  const t = ticket(c); let called = false;
  client.onPrivateMessage(() => { called = true; assert.equal(c.ownsConsumption(t.value), false); });
  await client.dispatchEvent({ post_type: 'message', message_type: 'private', self_id: 456 });
  assert.equal(called, true); assert.equal(isOriginLedgerConsumption(t.value), false);
  c.dispose();
});

test('old query cannot open after close, reconnect, conflict, or disposal', async () => {
  for (const event of ['close', 'reconnect', 'conflict', 'dispose']) {
    const f = fixture(); f.client.emit('open'); const d = deferred(); f.client.replies.push(() => d.promise);
    const pending = f.c.verify();
    if (event === 'reconnect') { f.client.emit('close'); f.client.emit('open'); f.client.ok(); assert.equal(await f.c.verify(), true); }
    else if (event === 'conflict') f.c.observeEvent({ post_type: 'message', self_id: 456 });
    else if (event === 'dispose') f.c.dispose(); else f.client.emit('close');
    d.resolve({ user_id: 123 }); assert.equal(await pending, false);
    assert.equal(f.c.isReady(), event === 'reconnect'); f.c.dispose();
  }
});

test('reverification revokes previous source and failure remains closed', async () => {
  const f = fixture(); await open(f); const t = ticket(f.c); const d = deferred(); f.client.replies.push(() => d.promise);
  const pending = f.c.verify(); assert.equal(isOriginLedgerConsumption(t.value), false); assert.equal(f.c.isReady(), false);
  d.resolve({ user_id: 456 }); assert.equal(await pending, false); assert.throws(() => f.c.getLedger('s'));
  f.client.ok(); assert.equal(await f.c.verify(), true); assert.equal(f.c.ownsConsumption(t.value), false); f.c.dispose();
});

test('操作前身份复核开始即永久撤销旧来源，成功后建立新代际', async () => {
  const f = fixture(); await open(f); const t = ticket(f.c); const epoch = f.c.sourceEpoch();
  const d = deferred(); f.client.replies.push(() => d.promise);
  const pending = f.c.refreshIdentity();
  assert.equal(f.c.isReady(), false); assert.throws(() => f.c.getLedger('other'));
  assert.equal(isOriginLedgerConsumption(t.value), false);
  d.resolve({ user_id: 123 }); assert.equal(await pending, true);
  assert.notEqual(f.c.sourceEpoch(), epoch); assert.equal(f.c.ownsConsumption(t.value), false);
  f.c.dispose();
});

test('操作前身份复核失败必须撤销在途来源，不得因旧查询迟到恢复', async () => {
  const f = fixture(); await open(f); const t = ticket(f.c);
  f.client.ok(456); assert.equal(await f.c.refreshIdentity(), false);
  assert.equal(isOriginLedgerConsumption(t.value), false); assert.equal(f.c.isReady(), false);
  f.c.dispose();
});

test('同一假客户端组合：身份冲突后旧票据不得再发起空间读取', async () => {
  const f = fixture(); await open(f); const t = ticket(f.c);
  let state = { enabled: true, readAllowed: true, writeAllowed: false, accessPaused: false, writePaused: false,
    tools: { read_posts: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [] };
  const store = { read: () => structuredClone(state), update(fn) { state = fn(structuredClone(state)); return state; } };
  let calls = 0;
  const runtime = createQzoneRuntime({ store, botQq: 123, sourceEpoch: f.c.sourceEpoch(),
    getConnectionEpoch: f.c.connectionEpoch, authorizeSource: f.c.ownsConsumption, getBridgeSessions: () => t.l,
    clock: () => Date.parse('2026-11-10T04:00:00Z'), mode: 'read-only',
    call: async () => { calls++; throw new Error('unexpected'); } });
  assert.equal(f.c.observeEvent({ post_type: 'message', self_id: 456 }), false);
  assert.equal((await runtime.dispatch('read_posts', { target_uin: 456 },
    { sessionId: 's', callId: 'c', binding: t.value })).error, 'origin-unverified');
  assert.equal(calls, 0); f.c.dispose();
});

test('身份重查未完成时，在途请求不得通过最终发送检查', async () => {
  const f = fixture(); await open(f); const t = ticket(f.c);
  let state = { enabled: true, readAllowed: true, writeAllowed: false, accessPaused: false, writePaused: false,
    tools: { read_posts: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [] };
  const store = { read: () => structuredClone(state), update(fn) { state = fn(structuredClone(state)); return state; } };
  const friendGate = deferred(), identityGate = deferred();
  let entered; const friendEntered = new Promise((resolve) => { entered = resolve; });
  let spaceCalls = 0;
  const runtime = createQzoneRuntime({ store, botQq: 123, sourceEpoch: f.c.sourceEpoch(),
    getConnectionEpoch: f.c.connectionEpoch, authorizeSource: f.c.ownsConsumption, getBridgeSessions: () => t.l,
    clock: () => Date.parse('2026-11-10T04:00:00Z'), mode: 'read-only', call: async (action) => {
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') { entered(); await friendGate.promise; return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] }; }
      if (action === 'get_qzone_msg_list') { spaceCalls++; return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } }; }
      throw new Error('unexpected');
    } });
  const request = runtime.dispatch('read_posts', { target_uin: 456 }, { sessionId: 's', callId: 'c', binding: t.value });
  await friendEntered;
  f.client.replies.push(() => identityGate.promise);
  const refresh = f.c.refreshIdentity();
  friendGate.resolve();
  assert.equal((await request).error, 'read-denied');
  assert.equal(spaceCalls, 0);
  identityGate.resolve({ user_id: 456 }); assert.equal(await refresh, false);
  f.c.dispose();
});

test('overlapping checks are ordered; stale failure cannot revoke newer success', async () => {
  const f = fixture(); f.client.emit('open'); const d = deferred(); f.client.replies.push(() => d.promise);
  const old = f.c.verify(); f.client.ok(); assert.equal(await f.c.verify(), true);
  const t = ticket(f.c); d.reject(new Error('old')); assert.equal(await old, false);
  assert.equal(f.c.ownsConsumption(t.value), true); f.c.dispose();
});

test('dispose revokes, removes listeners and stays closed', async () => {
  const f = fixture(); await open(f); const t = ticket(f.c); f.c.dispose(); f.c.dispose();
  assert.equal(isOriginLedgerConsumption(t.value), false); assert.equal(f.c.connectionEpoch(), -1);
  assert.equal(f.client.listenerCount('open'), 0); assert.equal(f.client.listenerCount('event'), 0);
  f.client.emit('open'); assert.equal(await f.c.verify(), false); assert.throws(() => f.c.getLedger('s'));
});

test('invalid configuration rejected and capacity preserves existing ledger', async () => {
  assert.throws(() => createQzoneConnectionSourceCoordinator({ client: new Client(), expectedUserId: '123' }));
  const noMiddleware = new EventEmitter(); noMiddleware.getLoginInfo = async () => ({ user_id: 123 });
  assert.throws(() => createQzoneConnectionSourceCoordinator({ client: noMiddleware, expectedUserId: 123 }));
  const alreadyRegistered = new Client(); alreadyRegistered.middlewares.push(() => {});
  assert.throws(() => createQzoneConnectionSourceCoordinator({ client: alreadyRegistered, expectedUserId: 123 }));
  const client = new Client(); const c = createQzoneConnectionSourceCoordinator({ client, expectedUserId: 123, sessionLimit: 1 });
  client.emit('open'); client.ok(); await c.verify(); const t = ticket(c);
  assert.throws(() => c.getLedger('other')); assert.equal(c.ownsConsumption(t.value), true); c.dispose();
});
