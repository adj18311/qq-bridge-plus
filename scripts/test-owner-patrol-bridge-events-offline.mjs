import test from 'node:test';
import assert from 'node:assert/strict';
import { busyHarness, feedFrames } from './busy-watchdog-harness.mjs';
import { transformOfflineOwnerPatrolBridge } from './owner-patrol-bridge-fixture-transform.mjs';
import { createSnapshotBoundaryExperiment } from './owner-patrol-snapshot-boundary-prototype.mjs';
import { once } from 'node:events';
import { createOfflinePatrolSendGate } from './owner-patrol-send-gate-prototype.mjs';

test('管理员会话已有运行回合时跳过巡逻机会，空闲后允许同一会话的后续机会', async () => {
  const h = await busyHarness({ config: { socialV2: { enabled: true } } });
  try {
    h.setMode('reserved2'); h.setReady(true); h.socialV2.paused = false;
    const sessionId = await h.ensureSession('private:123');
    h.v2TurnStartAt.set(sessionId, Date.now());
    const busy = await h.deliverPrompt('private:123', '离线巡逻机会', { backgroundPatrol: true });
    assert.equal(busy.skipped, true);
    assert.equal(busy.reason, 'qq-busy');
    assert.equal(h.calls.prompts.length, 0);
    h.v2TurnStartAt.delete(sessionId); // 仅模拟桥接已观察到回合结束。
    const idle = await h.deliverPrompt('private:123', '下一次离线巡逻机会', { backgroundPatrol: true });
    assert.equal(idle.ok, true);
    assert.equal(idle.sessionId, sessionId);
    assert.equal(h.calls.prompts.length, 1);
  } finally { await h.close(); }
});

test('已有未读工具能读取巡逻期间的管理员来信且不清除消息，普通回复仍可发送', async () => {
  const hooks = { boundary: createSnapshotBoundaryExperiment() };
  const h = await busyHarness({ config: { socialV2: { enabled: true } }, transformSource: transformOfflineOwnerPatrolBridge, globals: { __offlineOwnerPatrol: hooks } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await once(server, 'listening');
    h.setMode('reserved2'); h.socialV2.paused = false;
    await h.ensureSession('private:123');
    const st = h.getSocialV2State('private:123');
    await hooks.receive('private', 123, { self_id: 999, user_id: 123, message_id: 778, message: [{ type: 'text', data: { text: '请先回复我' } }] }, h.cfg);
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'x-agent-call': '1' };
    const unread = await fetch(`${base}/api/socialV2/unread?key=private%3A123&afterSeq=0`, { headers });
    const result = await unread.json();
    assert.equal(unread.status, 200);
    assert.ok(result.messages.some(m => m.messageId === '778' && (m.text ?? m.plain).includes('请先回复我')));
    assert.ok(st.unread.some(m => m.messageId === '778'), '读取不等于标记已读');
    const reply = await fetch(`${base}/api/socialV2/send-message`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'private:123', messages: ['这是离线正常回复'] }),
    });
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).sent, 1);
    assert.ok(st.recentMessages.some(m => m.isSelf && String(m.text ?? m.plain ?? '').includes('这是离线正常回复')));
    const denied = await fetch(`${base}/api/socialV2/unread?key=private%3A123`, { headers: { ...headers, 'x-agent-token': 'incorrect-fixture-token' } });
    assert.equal(denied.status, 403);
  } finally { server.closeAllConnections?.(); await new Promise(r => server.close(r)); await h.close(); }
});

test('桥接 VM 消费实时宿主帧及管理员来信，决定前来信抑制主动分享', async () => {
  const boundary = createSnapshotBoundaryExperiment();
  const hooks = { boundary };
  const h = await busyHarness({ config: { socialV2: { enabled: true } }, transformSource: transformOfflineOwnerPatrolBridge, globals: { __offlineOwnerPatrol: hooks } });
  try {
    h.setMode('reserved2'); h.socialV2.paused = false;
    const sessionId = await h.ensureSession('private:123');
    const stream = boundary.openFollow({ sessionId });
    assert.equal(stream.snapshot({ type: 'snapshot', cursor: 0, records: [] }), true);
    assert.equal(boundary.begin({ sessionId, requestId: 'req', ownerPending: false }), true);
    hooks.stream = stream;
    hooks.sessionId = sessionId;
    await feedFrames(h, [
      { type: 'session/event', sessionId: 'other-session', event: { seq: 99, type: 'turn/start', data: { turn: 22 } } },
      { type: 'session/event', sessionId, event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
      { type: 'session/event', sessionId, event: { seq: 2, type: 'user/message', data: { source: { kind: 'user', rpcId: 'req' } } } },
      { type: 'session/event', sessionId, event: { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '一条巡逻分享' }] } } } },
    ], 40);
    await hooks.receive('private', 123, { self_id: 999, user_id: 123, message_id: 773, message: [{ type: 'text', data: { text: '管理员来信' } }] }, h.cfg);
    await feedFrames(h, [{ type: 'session/event', sessionId, event: { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } }], 40);
    assert.equal(boundary.results.length, 1);
    assert.equal(boundary.results[0].share, false);
    assert.ok(h.getSocialV2State('private:123').unread.some(m => m.messageId === '773'));
    assert.match(h.readLog(), /AI 内部输出（不自动转发）/, 'reserved2 的 assistant 文本本来不会自动发送');
    assert.equal(h.calls.sent.length, 0, '仅证明未调用 QQ 工具时没有自动发送，不证明工具发送被拦截');
  } finally { await h.close(); }
});

test('当前真实发送端点对同一会话来信不自动咨询离线样品（明确揭示未接线）', async () => {
  const boundary = createSnapshotBoundaryExperiment();
  const hooks = { boundary };
  const h = await busyHarness({ config: { socialV2: { enabled: true } }, transformSource: transformOfflineOwnerPatrolBridge, globals: { __offlineOwnerPatrol: hooks } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await once(server, 'listening');
    h.setMode('reserved2'); h.socialV2.paused = false;
    const sessionId = await h.ensureSession('private:123');
    const token = h.getSocialV2State('private:123').agentToken;
    const stream = boundary.openFollow({ sessionId }); hooks.stream = stream; hooks.sessionId = sessionId;
    stream.snapshot({ type: 'snapshot', cursor: 0, records: [] });
    assert.equal(boundary.begin({ sessionId, requestId: 'req', ownerPending: false }), true);
    await feedFrames(h, [
      { type: 'session/event', sessionId, event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
      { type: 'session/event', sessionId, event: { seq: 2, type: 'user/message', data: { source: { kind: 'user', rpcId: 'req' } } } },
    ], 40);
    await hooks.receive('private', 123, { self_id: 999, user_id: 123, message_id: 774, message: [{ type: 'text', data: { text: '请先听我说' } }] }, h.cfg);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/send-message`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'x-agent-call': '1' },
      body: JSON.stringify({ key: 'private:123', messages: ['离线假消息'] }),
    });
    const body = await response.json();
    assert.equal(body.ok, true, `发送 API 结果: ${JSON.stringify(body)}`);
    assert.equal(response.status, 200, '当前未接线，应明确暴露端点仍会接受发送');
    assert.equal(body.sent, 1, `端点宣称的假发送条数：${JSON.stringify(body)}`);
    await feedFrames(h, [{ type: 'session/event', sessionId, event: { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } }], 40);
    assert.equal(boundary.results[0].share, false, '回合结束才知道不应分享已太晚');
  } finally { server.closeAllConnections?.(); await new Promise(r => server.close(r)); await h.close(); }
});

test('桥接 VM 收到目标会话订阅中断，须先使候选失效', async () => {
  const boundary = createSnapshotBoundaryExperiment(); const sendGate = createOfflinePatrolSendGate(); const hooks = { boundary, sendGate };
  const h = await busyHarness({ config: { socialV2: { enabled: true } }, transformSource: transformOfflineOwnerPatrolBridge, globals: { __offlineOwnerPatrol: hooks } });
  try {
    h.setMode('reserved2'); h.socialV2.paused = false;
    const sessionId = await h.ensureSession('private:123');
    hooks.sessionId = sessionId; hooks.stream = boundary.openFollow({ sessionId });
    hooks.stream.snapshot({ type: 'snapshot', cursor: 0, records: [] });
    assert.equal(boundary.begin({ sessionId, requestId: 'req', ownerPending: false }), true);
    sendGate.begin({ sessionId, turn: 1 });
    await feedFrames(h, [
      { type: 'session/event', sessionId, event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
      { type: 'session/event', sessionId, event: { seq: 2, type: 'user/message', data: { source: { kind: 'user', rpcId: 'req' } } } },
      { type: 'session/follow-ended', sessionId },
      { type: 'session/event', sessionId, event: { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
    ], 80);
    assert.equal(boundary.results.length, 0);
    assert.equal(boundary.begin({ sessionId, requestId: 'new', ownerPending: false }), false);
    assert.equal(sendGate.claimSend({ sessionId, turn: 1 }).allow, false, '断流后发送状态未知，不得继续放行');
    assert.equal(sendGate.finish({ sessionId, turn: 1 }), false, '迟到结束帧不得释放不确定中的任务');
  } finally { await h.close(); }
});

test('离线候选：来信后拦截当轮主动发送，回合结束后仍允许正常回复', async () => {
  const boundary = createSnapshotBoundaryExperiment(); const sendGate = createOfflinePatrolSendGate(); const hooks = { boundary, sendGate };
  const h = await busyHarness({ config: { socialV2: { enabled: true } }, transformSource: transformOfflineOwnerPatrolBridge, globals: { __offlineOwnerPatrol: hooks } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await once(server, 'listening');
    h.setMode('reserved2'); h.socialV2.paused = false;
    const sessionId = await h.ensureSession('private:123');
    const st = h.getSocialV2State('private:123');
    hooks.sessionId = sessionId; hooks.stream = boundary.openFollow({ sessionId });
    hooks.stream.snapshot({ type: 'snapshot', cursor: 0, records: [] });
    boundary.begin({ sessionId, requestId: 'req', ownerPending: false });
    assert.equal(sendGate.begin({ sessionId, turn: 1 }), true); // 夹具提供已核实的回合号
    await feedFrames(h, [
      { type: 'session/event', sessionId, event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
      { type: 'session/event', sessionId, event: { seq: 2, type: 'user/message', data: { source: { kind: 'user', rpcId: 'req' } } } },
    ], 40);
    await hooks.receive('private', 123, { self_id: 999, user_id: 123, message_id: 775, message: [{ type: 'text', data: { text: '先看我的消息' } }] }, h.cfg);
    const send = async message => fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/send-message`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'x-agent-call': '1' },
      body: JSON.stringify({ key: 'private:123', messages: [message] }),
    });
    const blocked = await send('离线巡逻分享');
    assert.equal(blocked.status, 409);
    assert.equal(st.sendTimes.length, 0, '拦截发生在频率额度预占之前');
    assert.ok(st.unread.some(m => m.messageId === '775'));
    const directReply = await send('直接回复管理员的离线消息');
    assert.equal(directReply.status, 409, '反例：会话级门禁不能分辨主动分享和同回合正常回复');
    assert.ok(st.unread.some(m => m.messageId === '775'), '误拦后管理员来信仍须保留');
    const bypass = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/send-burst`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'x-agent-call': '1' },
      body: JSON.stringify({ key: 'private:123', messages: ['旁路假消息'] }),
    });
    assert.equal(bypass.status, 200, '反例：尚未接线的 burst 端点仍可绕过，不得宣称覆盖全部发送');
    assert.equal((await bypass.json()).sent, 1);
    const legacy = await fetch(`http://127.0.0.1:${server.address().port}/api/send/private`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'x-agent-call': '1' },
      body: JSON.stringify({ userId: 123, message: '旧端点假消息', token: st.agentToken }),
    });
    assert.equal(legacy.status, 200, '反例：旧私聊端点也可绕过当前候选');
    await feedFrames(h, [{ type: 'session/event', sessionId, event: { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } }], 40);
    assert.equal(sendGate.finish({ sessionId, turn: 1 }), true); // 夹具模拟真实事件收尾
    const reply = await send('离线正常回复');
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).sent, 1);
    assert.ok(st.recentMessages.some(m => m.isSelf && String(m.text ?? m.plain ?? '').includes('离线正常回复')),
      '假网关成功后必须写入当前会话的自身消息记录');
  } finally { server.closeAllConnections?.(); await new Promise(r => server.close(r)); await h.close(); }
});

test('离线候选：发送已进入假网关后管理员来信，不撤回已决定的发送', async () => {
  const boundary = createSnapshotBoundaryExperiment();
  const sendGate = createOfflinePatrolSendGate();
  const hooks = { boundary, sendGate };
  let markEntered; let release;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const waitForRelease = new Promise(resolve => { release = resolve; });
  const h = await busyHarness({
    config: { socialV2: { enabled: true } },
    transformSource: transformOfflineOwnerPatrolBridge,
    globals: {
      __offlineOwnerPatrol: hooks,
      fetch: async () => {
        markEntered();
        await waitForRelease;
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
      },
    },
  });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await once(server, 'listening');
    h.setMode('reserved2'); h.socialV2.paused = false;
    const sessionId = await h.ensureSession('private:123');
    const st = h.getSocialV2State('private:123');
    hooks.sessionId = sessionId; hooks.stream = boundary.openFollow({ sessionId });
    hooks.stream.snapshot({ type: 'snapshot', cursor: 0, records: [] });
    boundary.begin({ sessionId, requestId: 'req', ownerPending: false });
    assert.equal(sendGate.begin({ sessionId, turn: 1 }), true);
    await feedFrames(h, [
      { type: 'session/event', sessionId, event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
      { type: 'session/event', sessionId, event: { seq: 2, type: 'user/message', data: { source: { kind: 'user', rpcId: 'req' } } } },
    ], 40);
    const pending = fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/send-message`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'x-agent-call': '1' },
      body: JSON.stringify({ key: 'private:123', messages: ['已决定的离线分享'] }),
    });
    await entered;
    await hooks.receive('private', 123, { self_id: 999, user_id: 123, message_id: 776, message: [{ type: 'text', data: { text: '发送过程中来信' } }] }, h.cfg);
    assert.ok(st.unread.some(m => m.messageId === '776'));
    release();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).sent, 1);
    assert.ok(st.recentMessages.some(m => m.isSelf && String(m.text ?? m.plain ?? '').includes('已决定的离线分享')));
  } finally { release(); server.closeAllConnections?.(); await new Promise(r => server.close(r)); await h.close(); }
});
