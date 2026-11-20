import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('真实巡逻派发使用既有管理员会话，自然分享而非独立会话代发', async () => {
  const h = await bridgeHarness({ config: {
    socialV2: { enabled: true },
    backgroundPatrol: { enabled: true, platforms: { tieba: true, xiaoheihe: true } },
  } });
  try {
    h.setMode('reserved2'); h.setReady(true); h.socialV2.paused = false;
    const ownerSession = await h.ensureSession('private:123');
    const ownerToken = h.getSocialV2State('private:123').agentToken;
    const creationsBefore = h.calls.created.length;
    const sendsBefore = h.calls.sent.length;
    h.state.sessions['patrol:background'] = 'fixture-old-background';
    const result = await h.dispatchBackgroundPatrolOpportunity('tieba', {});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sessionId, ownerSession);
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.calls.prompts[0].sessionId, ownerSession);
    assert.equal(h.calls.created.length, creationsBefore, '已有管理员会话时不应为这次机会创建新会话');
    const text = h.calls.prompts[0].content.map(item => item.text ?? '').join('\n');
    assert.doesNotMatch(text, /不得代替用户执行任何写操作|不要向 QQ 发送任何消息|<patrol-report/);
    assert.ok(text.includes(ownerToken), '应使用同一 QQ 会话令牌调用旧有会话工具');
    assert.equal(h.calls.sent.length, sendsBefore, '派发机会本身不应代发 QQ');
  } finally { await h.close(); }
});

test('closed-agent 模式也把定时机会投递到原管理员会话', async () => {
  const h = await bridgeHarness({ config: {
    socialV2: { enabled: true },
    backgroundPatrol: { enabled: true, platforms: { tieba: true } },
  } });
  try {
    h.setMode('closed-agent'); h.setReady(true);
    const ownerSession = await h.ensureSession('private:123');
    h.state.sessions['patrol:background'] = 'fixture-old-background';
    const result = await h.dispatchBackgroundPatrolOpportunity('tieba', {});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sessionId, ownerSession);
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.calls.prompts[0].sessionId, ownerSession);
  } finally { await h.close(); }
});
