import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  const h = await bridgeHarness();
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.stack ?? error); }
  finally { await h.close(); }
}

await test('未提供 requestId 时自铸一个规范 v4 UUID', async (h) => {
  await h.deliverPrompt('group:456', 'fixture prompt');
  // ⚠️ CHANGED by e4b56a2. This case used to require the key to be ABSENT. Every prompt now
  // carries a requestId, because the origin ledger binds a tool call to the message that caused
  // it via `source.rpcId` — a delivery without one can never be bound, so qzone tools would
  // answer `origin-unbound` on the step that matters.
  //
  // What the case still pins: the id is MINTED, not inherited, and it is a well-formed v4 UUID.
  const { requestId } = h.calls.prompts[0];
  assert.equal(typeof requestId, 'string');
  assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  // The rest of the prompt shape is unchanged.
  assert.deepEqual(Object.keys(h.calls.prompts[0]).filter((key) => key !== 'requestId'),
    ['sessionId', 'mode', 'content']);
  assert.equal(h.calls.prompts[0].sessionId, 'fixture-1');
  assert.equal(h.calls.prompts[0].mode, 'queue');
  assert.match(h.calls.prompts[0].content[0].text, /fixture prompt$/);
});

await test('规范 v4 UUID 原样透传', async (h) => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  await h.deliverPrompt('group:456', 'fixture prompt', { requestId });
  assert.equal(h.calls.prompts[0].requestId, requestId);
});

await test('恶意或非规范值不进入 DSH prompt 参数', async (h) => {
  const values = [
    '', 'not-a-uuid', '123e4567-e89b-42d3-a456-426614174000\nextra', '123e4567-e89b-42d3-a456-426614174000\n',
    '123e4567-e89b-12d3-a456-426614174000', { toString: () => '123e4567-e89b-42d3-a456-426614174000' },
  ];
  for (const requestId of values) {
    await h.deliverPrompt('group:456', 'fixture prompt', { requestId });
    // The VALUE must never be forwarded. Since e4b56a2 a rejected value is replaced by a minted
    // v4 UUID rather than dropped entirely — so the assertion is that the rejected input did not
    // survive, not that the key is missing.
    const forwarded = h.calls.prompts.at(-1).requestId;
    assert.notEqual(forwarded, requestId, '恶意/非规范值不得被转发');
    assert.match(forwarded, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      '被拒的值必须换成自铸的规范 UUID');
  }
});

await test('离线队列不保存 requestId，恢复补投时不标记来源', async (h) => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  h.setReady(false);
  assert.equal((await h.deliverPrompt('group:456', 'offline prompt', { requestId })).queued, true);
  h.setReady(true);
  await h.flushQueue();
  assert.equal(h.calls.prompts.length, 1);
  // ⚠️ CHANGED by e4b56a2. Every prompt now carries a requestId: the origin ledger needs the
  // source message's rpcId, and a delivery that carries none can never be bound to its turn.
  // What must remain true is the property this case actually exists to protect — the OFFLINE
  // QUEUE does not PERSIST the original id, so a resumed delivery cannot be mistaken for the
  // bridge request that queued it. A freshly minted id is a different id.
  assert.notEqual(h.calls.prompts[0].requestId, requestId,
    '恢复补投不得沿用入队时的 requestId（离线队列不保存它）');
});

await test('会话创建期间 reset 后重试不透传旧 requestId', async (h) => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  h.api.sessions.selectModel = async () => {
    h.resetEpoch();
    return { result: { ok: true, value: { selected: {} } } };
  };
  assert.equal((await h.deliverPrompt('group:456', 'reset prompt', { requestId })).retried, true);
  h.api.sessions.selectModel = async () => ({ result: { ok: true, value: { selected: {} } } });
  await h.flushQueue();
  assert.equal(h.calls.prompts.length, 1);
  // Same rule as above: the RETRY must not reuse the pre-reset id, but a prompt still carries one.
  assert.notEqual(h.calls.prompts[0].requestId, requestId,
    'reset 后重试不得沿用旧 requestId');
});

if (failures) process.exitCode = 1;
