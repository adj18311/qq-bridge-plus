import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOfflineDshClient } from './owner-patrol-dsh-client-candidate.mjs';
import { createExternalEventExperiment } from './owner-patrol-external-events-prototype.mjs';
import { createSnapshotBoundaryExperiment } from './owner-patrol-snapshot-boundary-prototype.mjs';

class FakeSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3; static instance;
  constructor() { this.readyState = 0; this.listeners = new Map(); this.frames = []; FakeSocket.instance = this; }
  addEventListener(k, f) { if (!this.listeners.has(k)) this.listeners.set(k, new Set()); this.listeners.get(k).add(f); }
  removeEventListener(k, f) { this.listeners.get(k)?.delete(f); }
  emit(k, e = {}) { for (const f of this.listeners.get(k) ?? []) f(e); }
  open() { this.readyState = 1; this.emit('open'); }
  send(s) { this.frames.push(JSON.parse(s)); }
  frame(value) { this.emit('message', { data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.emit('close'); }
}
const flush = () => new Promise(r => setImmediate(r));
test('会话订阅报错也要先通知具体会话失效', async () => {
  const original = globalThis.WebSocket; globalThis.WebSocket = FakeSocket;
  const abort = new AbortController();
  try {
    const Client = await loadOfflineDshClient();
    const api = new Client('http://127.0.0.1:1', 1000, { tokenExplicit: false });
    api.cookie = 'fixture=ok'; api.events.follow('s');
    const iterator = api.events.mux({}, abort.signal)[Symbol.asyncIterator]();
    const pending = iterator.next(); await flush();
    const socket = FakeSocket.instance; socket.open();
    const follow = socket.frames.find(x => x.endpoint === 'session/follow');
    socket.frame({ type: 'error', streamId: follow.streamId, error: { code: 'session/not-found' } });
    const signal = (await pending).value.payload;
    assert.equal(signal.type, 'session/follow-ended');
    assert.equal(signal.sessionId, 's');
  } finally { abort.abort(); globalThis.WebSocket = original; }
});
test('单会话结束应在 mux 不断开时输出中断信号', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const abort = new AbortController();
  try {
    const Client = await loadOfflineDshClient();
    const api = new Client('http://127.0.0.1:1', 1000, { tokenExplicit: false });
    api.cookie = 'fixture=ok'; api.events.follow('s');
    const iterator = api.events.mux({}, abort.signal)[Symbol.asyncIterator]();
    const pending = iterator.next(); await flush();
    const socket = FakeSocket.instance; socket.open();
    const follow = socket.frames.find(x => x.endpoint === 'session/follow');
    socket.frame({ type: 'end', streamId: follow.streamId });
    const observed = await Promise.race([pending, flush().then(() => null)]);
    assert.equal(observed?.value?.payload?.type, 'session/follow-ended');
    assert.equal(observed.value.payload.sessionId, 's');
    assert.equal(socket.readyState, FakeSocket.OPEN, '总连接不得被关闭');
  } finally { abort.abort(); globalThis.WebSocket = original; }
});

test('单流断开通知使该任务失效，重订阅与迟到帧不导致误分享', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const abort = new AbortController();
  try {
    const Client = await loadOfflineDshClient();
    const api = new Client('http://127.0.0.1:1', 1000, { tokenExplicit: false });
    api.cookie = 'fixture=ok'; api.events.follow('s');
    const iterator = api.events.mux({}, abort.signal)[Symbol.asyncIterator]();
    const initial = iterator.next(); await flush();
    const socket = FakeSocket.instance; socket.open();
    const originalFollow = socket.frames.find(x => x.endpoint === 'session/follow');
    const correlator = createExternalEventExperiment();
    correlator.begin({ sessionId: 's', requestId: 'req' });
    const push = event => socket.frame({ type: 'item', streamId: originalFollow.streamId, value: { type: 'event', event } });
    push({ seq: 0, type: 'turn/start', data: { turn: 1 } });
    const first = await initial; correlator.accept(first.value.payload);
    const second = iterator.next(); push({ seq: 1, type: 'user/message', data: { source: { kind: 'user', rpcId: 'req' } } });
    correlator.accept((await second).value.payload);
    const interrupted = iterator.next(); socket.frame({ type: 'end', streamId: originalFollow.streamId });
    const signal = (await interrupted).value.payload;
    assert.equal(signal.type, 'session/follow-ended');
    // 手动模拟未来桥接事件分发：只让相关 session 的协调器失效。
    correlator.followEnded({ sessionId: signal.sessionId });
    await new Promise(r => setTimeout(r, 2100));
    const reopened = socket.frames.filter(x => x.endpoint === 'session/follow');
    assert.equal(reopened.length, 2);
    assert.notEqual(reopened[1].streamId, originalFollow.streamId);
    assert.equal(socket.readyState, FakeSocket.OPEN);
    const next = iterator.next();
    push({ seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    socket.frame({ type: 'item', streamId: reopened[1].streamId, value: { type: 'snapshot', cursor: 4, records: [{ seq: 4, type: 'turn/end' }] } });
    const snapshotFrame = (await next).value.payload;
    assert.equal(snapshotFrame.type, 'session/snapshot');
    assert.deepEqual(correlator.results, []);
    const boundary = createSnapshotBoundaryExperiment();
    const stream = boundary.openFollow({ sessionId: 's' });
    assert.equal(stream.snapshot(snapshotFrame.snapshot), true);
    assert.equal(boundary.begin({ sessionId: 's', requestId: 'new', ownerPending: false }), true);
    for (const event of [
      { seq: 5, type: 'turn/start', data: { turn: 2 } },
      { seq: 6, type: 'user/message', data: { source: { kind: 'user', rpcId: 'new' } } },
      { seq: 7, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ]) {
      const pending = iterator.next();
      socket.frame({ type: 'item', streamId: reopened[1].streamId, value: { type: 'event', event } });
      stream.live((await pending).value.payload.event);
    }
    assert.deepEqual(boundary.results, [{ turn: 2, share: true }]);
  } finally { abort.abort(); globalThis.WebSocket = original; }
});
