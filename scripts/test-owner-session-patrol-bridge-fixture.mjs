// 离线拼接实验：真实 bridge 的来信入库 + 由测试手动驱动的协调器。
// 没有生产接线，不接真实 QQ/DSH，不能证明入库与分享检查原子化。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createOfflinePatrolCoordinator } from './owner-session-patrol-coordinator-prototype.mjs';
import { createOfflineHostEventCoordinator } from './owner-session-patrol-host-events-prototype.mjs';

function timer() { return { unref() {} }; }
const event = (id, text) => ({ self_id: 999, user_id: 123, message_id: id, message: [{ type: 'text', data: { text } }] });

test('隔离接线：已认证的模拟来信经真实桥接入库并抑制对应回合分享', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } }, globals: { setTimeout: timer, clearTimeout() {} } });
  try {
    h.setMode('reserved2'); h.socialV2.paused = false;
    const sessionId = await h.ensureSession('private:123');
    const a = createOfflineHostEventCoordinator();
    a.begin({ sessionId, messageId: 'patrol-fixture' });
    a.hostStep({ sessionId, turn: 1, messages: [{ id: 'patrol-fixture' }] });
    await a.receiveOwner({ sessionId, messageId: '902', receive: () => h.handleIncoming('private', 123, event(902, '测试'), h.cfg) });
    a.hostEvent({ sessionId, event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
    assert.equal(a.decisions[0].share, false);
    assert.ok(h.getSocialV2State('private:123').unread.some(m => m.messageId === '902'));
    assert.equal(h.calls.sent.length, 0);
  } finally { await h.close(); }
});

test('隔离入口对比：非管理员或非管理员私聊不得中断分享决定', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } }, globals: { setTimeout: timer, clearTimeout() {} } });
  try {
    h.setMode('reserved2'); h.socialV2.paused = false;
    const sessionId = await h.ensureSession('private:123');
    const a = createOfflineHostEventCoordinator();
    a.begin({ sessionId, messageId: 'patrol-fixture' });
    a.hostStep({ sessionId, turn: 2, messages: [{ id: 'patrol-fixture' }] });
    // 此判别是离线入口候选，不是生产桥接已经具有的保障。
    const incoming = async (kind, id, e) => {
      const receive = () => h.handleIncoming(kind, id, e, h.cfg);
      if (kind === 'private' && String(id) === String(h.cfg.ownerQQ) && String(e.user_id) === String(h.cfg.ownerQQ)) {
        return a.receiveOwner({ sessionId, messageId: String(e.message_id), receive });
      }
      return receive();
    };
    await incoming('group', 456, { ...event(903, '群消息'), user_id: 123, group_id: 456 });
    await incoming('private', 321, { ...event(904, '其他私聊'), user_id: 321 });
    a.hostEvent({ sessionId, event: { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } } });
    assert.equal(a.decisions[0].share, true);
  } finally { await h.close(); }
});

test('离线接线探针：以管理员 key 投递机会应复用已有 session', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } }, globals: { setTimeout: timer, clearTimeout() {} } });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    h.socialV2.paused = false;
    // 由真实 ensureSession 建立 sessionPolicy；仅手写映射会因政策不匹配被退役。
    const ownerSession = await h.ensureSession('private:123');
    const creationsBefore = h.calls.created.length;
    const result = await h.deliverPrompt('private:123', '离线巡逻机会', { backgroundPatrol: true });
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, ownerSession);
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.calls.prompts[0].sessionId, ownerSession);
    assert.equal(h.calls.created.length, creationsBefore);
    assert.equal(h.calls.sent.length, 0);
  } finally { await h.close(); }
});

test('离线接线探针：已有 QQ 投递在排队时跳过机会', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } }, globals: { setTimeout: timer, clearTimeout() {} } });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    h.socialV2.paused = false;
    h.promptQueues.set('private:123', { queue: [], running: true });
    const result = await h.deliverPrompt('private:123', '离线巡逻机会', { backgroundPatrol: true });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'qq-busy');
    assert.equal(h.calls.prompts.length, 0);
  } finally { h.promptQueues.delete('private:123'); await h.close(); }
});

test('现有桥接反例：仅有未读消息、唤醒定时器尚未投递时不等同于 QQ 队列繁忙', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } }, globals: { setTimeout: timer, clearTimeout() {} } });
  try {
    h.setMode('reserved2'); h.setReady(true); h.socialV2.paused = false;
    const sessionId = await h.ensureSession('private:123');
    await h.handleIncoming('private', 123, event(905, '先处理我的来信'), h.cfg);
    assert.ok(h.getSocialV2State('private:123').unread.some(m => m.messageId === '905'));
    const result = await h.deliverPrompt('private:123', '离线巡逻机会', { backgroundPatrol: true });
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, sessionId, '当前函数仅检查队列与回合状态，不能把未读自动视为已拦截');
    assert.equal(h.calls.prompts.length, 1);
    assert.ok(h.getSocialV2State('private:123').unread.some(m => m.messageId === '905'));
  } finally { await h.close(); }
});

test('离线接线探针：DSH 不可用时机会不进入普通离线补发队列', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } }, globals: { setTimeout: timer, clearTimeout() {} } });
  try {
    h.setMode('reserved2');
    h.setReady(false);
    h.socialV2.paused = false;
    const result = await h.deliverPrompt('private:123', '离线巡逻机会', { backgroundPatrol: true });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'dsh-unavailable');
    assert.equal(h.queued.has('private:123'), false);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});

test('真实桥接入库后，测试手动把管理员未读移交样品并禁止自主分享', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } }, globals: { setTimeout: timer, clearTimeout() {} } });
  try {
    h.setMode('reserved2');
    h.socialV2.paused = false;
    const coordinator = createOfflinePatrolCoordinator();
    const task = coordinator.begin({ sessionId: 'fixture-owner-session', busy: false });
    await h.handleIncoming('private', 123, event(901, '管理员测试消息'), h.cfg);
    const st = h.getSocialV2State('private:123');
    const unread = st.unread.find((message) => message.messageId === '901');
    assert.ok(unread, '真实来信必须仍在桥接未读队列');
    assert.equal(unread.isOwner, true);
    // 这是夹具模拟接线，实际生产代码目前没有这一步。
    coordinator.ownerMessage({ sessionId: 'fixture-owner-session', messageId: unread.messageId });
    const decision = coordinator.finish({ sessionId: 'fixture-owner-session', taskId: task.taskId });
    assert.equal(decision.share, false);
    assert.deepEqual(decision.ownerMessages, ['901']);
    assert.ok(st.unread.some((message) => message.messageId === '901'), '样品不得消费真实桥接未读');
    assert.equal(h.calls.sent.length, 0, '样品不主动发送 QQ');
  } finally { await h.close(); }
});

test('真实桥接连续接收两条管理员消息时，手动交接不合并或清除未读', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } }, globals: { setTimeout: timer, clearTimeout() {} } });
  try {
    h.setMode('reserved2');
    h.socialV2.paused = false;
    const coordinator = createOfflinePatrolCoordinator();
    const task = coordinator.begin({ sessionId: 'fixture-owner-session', busy: false });
    for (const id of [911, 912]) {
      await h.handleIncoming('private', 123, event(id, `测试${id}`), h.cfg);
      const st = h.getSocialV2State('private:123');
      const unread = st.unread.find((message) => message.messageId === String(id));
      assert.ok(unread);
      coordinator.ownerMessage({ sessionId: 'fixture-owner-session', messageId: unread.messageId });
    }
    const decision = coordinator.finish({ sessionId: 'fixture-owner-session', taskId: task.taskId });
    assert.equal(decision.share, false);
    assert.deepEqual(decision.ownerMessages, ['911', '912']);
    assert.deepEqual(Array.from(h.getSocialV2State('private:123').unread, (item) => item.messageId), ['911', '912']);
    assert.equal(h.calls.sent.length, 0);
  } finally { await h.close(); }
});
