import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createOfflineOwnerPatrolWiring } from './owner-session-patrol-wiring-prototype.mjs';

function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
function fakeClock() {
  let now = Date.parse('2026-11-06T02:00:00Z');
  const timers = new Map(); let id = 0;
  return { now: () => now, setTimeout(fn, delay) { const k = ++id; timers.set(k, { fn, at: now + delay }); return k; }, clearTimeout(k) { timers.delete(k); },
    advance(ms) { now += ms; for (const [k, t] of [...timers]) if (t.at <= now) { timers.delete(k); t.fn(); } } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const timer = () => ({ unref() {} });
const event = id => ({ self_id: 999, user_id: 123, message_id: id, message: [{ type: 'text', data: { text: '来信' } }] });

async function fixture(beforeDelivery = null) {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } }, globals: { setTimeout: timer, clearTimeout() {} } });
  h.setMode('reserved2'); h.setReady(true); h.socialV2.paused = false;
  const sessionId = await h.ensureSession('private:123');
  const clock = fakeClock(); const end = deferred(); const decisions = []; const events = [];
  const deliverPrompt = async (...args) => {
    if (beforeDelivery) await beforeDelivery(h, wiring, sessionId);
    return h.deliverPrompt(...args);
  };
  const wiring = createOfflineOwnerPatrolWiring({ clock, sessionId, ownerKey: 'private:123', deliverPrompt,
    awaitTurn: () => end.promise, getAvailability: () => ({ dshAvailable: true, modeAllowed: true, paused: false, qqBusy: false }),
    hasOwnerUnread: () => h.getSocialV2State('private:123').unread.length > 0,
    onDecision: decision => decisions.push(decision), onEvent: e => events.push(e) });
  return { h, sessionId, clock, end, decisions, events, wiring };
}

test('定时机会到达前管理员有未读：跳过、不消耗未读，处理后下一平台机会可进入同一会话', async () => {
  const f = await fixture();
  try {
    await f.h.handleIncoming('private', 123, event(220), f.h.cfg);
    const st = f.h.getSocialV2State('private:123');
    f.wiring.start(); f.clock.advance(2700000); await flush();
    assert.equal(f.h.calls.prompts.length, 0, '未读存在时不应提交巡逻机会');
    assert.ok(st.unread.some(m => m.messageId === '220'), '跳过机会不清除消息');
    assert.equal(f.wiring.snapshot().runningPlatform, null);
    st.unread.splice(0, st.unread.length); // 仅模拟管理员消息已处理，不代表真实标读路径。
    f.clock.advance(900000); await flush();
    assert.equal(f.h.calls.prompts.length, 1, '下一次机会应继续可用');
    assert.equal(f.h.calls.prompts[0].sessionId, f.sessionId);
    f.end.resolve(); await flush();
  } finally { f.wiring.stop(); await f.h.close(); }
});

test('反例：未读检查后到信若没转交协调器，回合结束时样品仍误判可分享', async () => {
  const f = await fixture(async h => h.handleIncoming('private', 123, event(221), h.cfg));
  try {
    f.wiring.start(); f.clock.advance(2700000); await flush();
    assert.ok(f.h.getSocialV2State('private:123').unread.some(m => m.messageId === '221'));
    assert.equal(f.h.calls.prompts.length, 1, '消息在检查之后到达，机会仍进入同一会话');
    f.end.resolve(); await flush();
    assert.equal(f.decisions[0].share, true, '当前夹具未自动转交来信，证明不能仅靠入场未读检查');
    assert.equal(f.h.calls.sent.length, 0, '此样品只决定是否允许分享，没有真实 QQ 发送');
  } finally { f.wiring.stop(); await f.h.close(); }
});

test('检查后到信经测试手动转交后：仍保留未读，回合结束不批准主动分享', async () => {
  const f = await fixture(async (h, wiring, sessionId) => {
    await h.handleIncoming('private', 123, event(223), h.cfg);
    wiring.ownerMessage({ sessionId, messageId: '223' });
  });
  try {
    f.wiring.start(); f.clock.advance(2700000); await flush();
    assert.equal(f.h.calls.prompts.length, 1);
    f.end.resolve(); await flush();
    assert.equal(f.decisions[0].share, false);
    assert.ok(f.h.getSocialV2State('private:123').unread.some(m => m.messageId === '223'));
    assert.equal(f.h.calls.sent.length, 0);
  } finally { f.wiring.stop(); await f.h.close(); }
});

test('真实调度机会进入已有管理员会话，直至回合结束才释放租约', async () => {
  const f = await fixture();
  try {
    f.wiring.start(); f.clock.advance(2700000); await flush();
    assert.equal(f.h.calls.prompts.length, 1);
    assert.equal(f.h.calls.prompts[0].sessionId, f.sessionId);
    assert.equal(f.wiring.snapshot().runningPlatform, 'xiaoheihe');
    f.clock.advance(900000); await flush();
    assert.equal(f.h.calls.prompts.length, 1);
    assert.ok(f.events.some(e => e.reason === 'background-busy'));
    f.end.resolve(); await flush();
    assert.equal(f.wiring.snapshot().runningPlatform, null);
    assert.equal(f.decisions[0].share, true);
  } finally { f.wiring.stop(); await f.h.close(); }
});

test('来信入真实未读队列后交给离线接线，决定前不分享且不删除消息', async () => {
  const f = await fixture();
  try {
    f.wiring.start(); f.clock.advance(2700000); await flush();
    await f.h.handleIncoming('private', 123, event(222), f.h.cfg);
    f.wiring.ownerMessage({ sessionId: f.sessionId, messageId: '222' });
    f.end.resolve(); await flush();
    assert.equal(f.decisions[0].share, false);
    assert.ok(f.h.getSocialV2State('private:123').unread.some(m => m.messageId === '222'));
    assert.equal(f.h.calls.sent.length, 0);
  } finally { f.wiring.stop(); await f.h.close(); }
});

test('桥接忙碌时真实投递拒绝，样品不等待不存在的回合', async () => {
  const f = await fixture();
  try {
    f.h.promptQueues.set('private:123', { queue: [], running: true });
    f.wiring.start(); f.clock.advance(2700000); await flush();
    assert.equal(f.h.calls.prompts.length, 0);
    assert.equal(f.wiring.snapshot().runningPlatform, null);
    assert.equal(f.decisions.length, 0);
  } finally { f.h.promptQueues.delete('private:123'); f.wiring.stop(); await f.h.close(); }
});

test('回合结束信号失败时不允许分享且释放调度租约', async () => {
  const f = await fixture();
  try {
    f.wiring.start(); f.clock.advance(2700000); await flush();
    f.end.reject(new Error('fake host disconnect')); await flush();
    assert.equal(f.decisions.length, 0);
    assert.equal(f.wiring.snapshot().runningPlatform, null);
    assert.ok(f.events.some(e => e.type === 'failed'));
  } finally { f.wiring.stop(); await f.h.close(); }
});

test('决定之后才到的消息保留，已作决定不被撤回', async () => {
  const f = await fixture();
  try {
    f.wiring.start(); f.clock.advance(2700000); await flush();
    f.end.resolve(); await flush();
    assert.equal(f.decisions[0].share, true);
    await f.h.handleIncoming('private', 123, event(333), f.h.cfg);
    f.wiring.ownerMessage({ sessionId: f.sessionId, messageId: '333' });
    assert.equal(f.decisions[0].share, true);
    assert.ok(f.h.getSocialV2State('private:123').unread.some(m => m.messageId === '333'));
  } finally { f.wiring.stop(); await f.h.close(); }
});
