import assert from 'node:assert/strict';
import test from 'node:test';
import { loadOfflineHostFixture } from './qzone-host-prestep-fixture.mjs';
import { apply as applyQzone } from '../plugins/qzone-safe/index.mjs';

async function fixtureFor(t) {
  try { return await loadOfflineHostFixture(); }
  catch (error) {
    if (/本机找不到 DSH app\.asar/u.test(error.message)) { t.skip(error.message); return null; }
    throw error;
  }
}

test('真实 Agent 创建和销毁事件及 pre-step 作用域', async (t) => {
  const h = await fixtureFor(t);
  if (!h) return;
  const { cordis, session, projection, agent, agentLoop, llm, tools, systemPrompt, nativeExecutor } = h;
  const root = new cordis.Context();
  const handles = [];
  const created = [];
  const disposed = [];
  const observed = [];
  try {
    for (const plugin of [projection.SessionProjectionRegistry, session.SessionStore, agent.AgentRegistry,
      systemPrompt.SystemPrompt, llm.LlmRuntime, tools.ToolRuntime, nativeExecutor, agentLoop.AgentLoop]) root.plugin(plugin);
    await new Promise((resolve) => setTimeout(resolve, 0));
    class OfflineAdapter extends llm.LlmAdapter {
      providerInfo(provider) { return { id: provider, name: provider }; }
      resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
      async *stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'offline' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'offline' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const stopAdapter = root.get('llm').registerAdapter(['offline'], new OfflineAdapter());
    root.on('agent/created', (payload) => {
      created.push(payload);
      payload.agent.ctx.on('agent/pre-step', (step, next) => {
        observed.push([payload.agent.id, step.turn, step.step]);
        return next();
      });
    });
    root.on('agent/disposed', (payload) => disposed.push(payload));
    for (const id of ['fixture-agent-a', 'fixture-agent-b']) {
      handles.push(await root.get('agents').create({ sessionId: id, agentOptions: { provider: 'offline', model: 'fixture' } }));
    }
    assert.equal(created.length, 2);
    for (let i = 0; i < handles.length; i++) {
      assert.equal(created[i].agent, handles[i].agent);
      assert.equal(created[i].agent.session.id, handles[i].agent.id);
      assert.equal(created[i].source, 'startup');
      assert.equal(typeof created[i].agent.ctx.on, 'function');
      handles[i].agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'offline' }] }));
      await handles[i].agent.whenIdle();
    }
    assert.deepEqual(observed, [['fixture-agent-a', 1, 1], ['fixture-agent-b', 1, 1]]);
    await handles[0].dispose();
    assert.equal(disposed.length, 1);
    assert.deepEqual(Object.keys(disposed[0]), ['agent']);
    assert.equal(disposed[0].agent, handles[0].agent);
    handles[1].agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'offline again' }] }));
    await handles[1].agent.whenIdle();
    assert.deepEqual(observed, [['fixture-agent-a', 1, 1], ['fixture-agent-b', 1, 1], ['fixture-agent-b', 2, 1]]);
    await handles[1].dispose();
    assert.equal(disposed.length, 2);
    assert.equal(disposed[1].agent, handles[1].agent);
    stopAdapter();
    t.diagnostic(JSON.stringify({ archive: h.archive, createdKeys: Object.keys(created[0]), source: created[0].source,
      disposedKeys: Object.keys(disposed[0]), observed }));
  } finally {
    for (const handle of handles) await handle.dispose();
    await root.fiber.dispose();
    h.close();
  }
});

test('真实 Cordis 插件 apply 抛错、拒绝及 QZone 返回值的生命周期', async (t) => {
  const h = await fixtureFor(t);
  if (!h) return;
  const root = new h.cordis.Context();
  try {
    for (const kind of ['sync', 'async']) {
      let hits = 0;
      const failure = new Error(`fixture-${kind}`);
      const plugin = { name: `fixture-${kind}`, apply(ctx) {
        ctx.on('fixture/ping', () => { hits++; });
        if (kind === 'sync') throw failure;
        return Promise.reject(failure);
      } };
      const fiber = root.plugin(plugin);
      await assert.rejects(fiber.await(), (error) => error === failure);
      assert.equal(fiber.state, 3);
      root.emit('fixture/ping');
      assert.equal(hits, 0, '失败插件的事件订阅已卸载');
      let healthyHits = 0;
      const healthy = root.plugin({ name: `healthy-${kind}`, apply(ctx) { ctx.on('fixture/healthy', () => healthyHits++); } });
      await healthy.await();
      root.emit('fixture/healthy');
      assert.equal(healthyHits, 1);
      await healthy.dispose();
      await fiber.dispose();
    }
    // A disabled plugin must still load successfully as a Cordis effect.
    const actual = root.plugin({ name: 'qzone-disabled-fixture', apply: (ctx) => applyQzone(ctx, { enabled: false }) });
    await actual.await();
    assert.notEqual(actual.state, 3);
    await actual.dispose();
    t.diagnostic('同步抛错和异步拒绝均进入 state=3，清理已注册订阅；健康插件与 QZone disabled 插件可继续运行。');
  } finally {
    await root.fiber.dispose();
    h.close();
  }
});
