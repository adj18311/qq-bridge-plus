// Offline integration: the background session must use the owner's active model.
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const harness = await bridgeHarness({
  config: {
    ownerQQ: 123,
    agentPreset: 'qq-chat-v2',
    dsh: { provider: 'global-provider', model: 'global-model', reasoningEffort: 'low' },
    socialV2: { modelOverrides: { 'private:123': { provider: 'owner-provider', model: 'owner-model', reasoningEffort: 'high' } } },
    backgroundPatrol: { enabled: false },
  },
});

try {
  harness.setMode('reserved2');
  harness.cfg.backgroundPatrol.enabled = true;
  const selections = [];
  harness.api.sessions.selectModel = async (params) => {
    selections.push({ ...params });
    return { result: { ok: true, value: { selected: params } } };
  };
  await harness.ensureSession('private:123');
  await harness.ensureSession('patrol:background');
  assert.equal(selections.length, 2);
  assert.deepEqual(
    { provider: selections[1].provider, model: selections[1].model, reasoningEffort: selections[1].reasoningEffort },
    { provider: selections[0].provider, model: selections[0].model, reasoningEffort: selections[0].reasoningEffort },
    '后台巡逻模型及思考强度应继承管理员私聊的实际覆盖',
  );
  harness.cfg.socialV2.modelOverrides['private:123'] = { model: 'updated-model', reasoningEffort: 'medium' };
  await harness.ensureSession('patrol:background');
  assert.equal(selections[2].provider, 'global-provider');
  assert.equal(selections[2].model, 'updated-model');
  assert.equal(selections[2].reasoningEffort, 'medium');
  delete harness.cfg.socialV2.modelOverrides['private:123'];
  await harness.ensureSession('patrol:background');
  assert.equal(selections[3].model, 'global-model');
  assert.equal(selections[3].reasoningEffort, 'low');
  await harness.ensureSession('group:456');
  assert.equal(selections[4].model, 'global-model');
  console.log('PASS: 后台巡逻继承管理员私聊模型');
} finally {
  await harness.close();
}
