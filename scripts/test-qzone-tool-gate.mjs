import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneToolGate } from '../src/core/qzone-tool-gate.mjs';

const state = (overrides = {}) => ({
  enabled: true, readAllowed: true, writeAllowed: true,
  accessPaused: false, writePaused: false,
  tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
  ...overrides,
});

test('每次执行读取最新状态，并通过授权后才调用工具', async () => {
  let current = state();
  let reads = 0;
  const calls = [];
  const gate = createQzoneToolGate({ readState: () => { reads++; return current; } });
  const tool = gate.wrap('read_posts', async (input) => { calls.push(input); return 'ok'; });

  assert.equal(await tool({ n: 1 }), 'ok');
  current = state({ enabled: false });
  await assert.rejects(tool({ n: 2 }), /qzone tool denied/);
  assert.equal(reads, 2);
  assert.deepEqual(calls, [{ n: 1 }]);
});

test('总开关、逐工具开关、方向权限和读写熔断均拒绝工具', async () => {
  const cases = [
    ['read_posts', state({ enabled: false })],
    ['read_posts', state({ tools: { ...state().tools, read_posts: false } })],
    ['read_posts', state({ readAllowed: false })],
    ['read_posts', state({ accessPaused: true })],
    ['publish', state({ tools: { ...state().tools, publish: false } })],
    ['publish', state({ writeAllowed: false })],
    ['publish', state({ writePaused: true })],
  ];
  for (const [toolName, blocked] of cases) {
    const gate = createQzoneToolGate({ readState: () => blocked });
    let calls = 0;
    const tool = gate.wrap(toolName, () => { calls++; });
    await assert.rejects(tool(), /qzone tool denied/);
    assert.equal(calls, 0);
  }
});

test('状态读取失败或状态损坏时拒绝，且不触碰下游', async () => {
  for (const readState of [() => { throw new Error('unavailable'); }, () => null]) {
    const gate = createQzoneToolGate({ readState });
    let calls = 0;
    const tool = gate.wrap('read_posts', () => { calls++; });
    await assert.rejects(tool(), /qzone tool denied/);
    assert.equal(calls, 0);
  }
});

test('关闭 gate 后，先前取得的工具引用仍被拒绝', async () => {
  const gate = createQzoneToolGate({ readState: () => state() });
  let calls = 0;
  const tool = gate.wrap('read_posts', () => { calls++; });
  gate.close();
  await assert.rejects(tool(), /qzone tool denied/);
  assert.equal(calls, 0);
});

test('异步读取状态尚未完成时 close，读取完成后仍拒绝且不调用 handler', async () => {
  let finishRead;
  const gate = createQzoneToolGate({ readState: () => new Promise((resolve) => { finishRead = resolve; }) });
  let calls = 0;
  const tool = gate.wrap('publish', () => { calls++; });
  const invocation = tool();
  await new Promise((resolve) => setImmediate(resolve));
  gate.close();
  finishRead(state());
  await assert.rejects(invocation, /qzone tool denied/);
  assert.equal(calls, 0);
});

test('依赖无效和未知工具在创建或调用时拒绝', async () => {
  assert.throws(() => createQzoneToolGate({}), /invalid qzone tool gate dependencies/);
  const gate = createQzoneToolGate({ readState: () => state() });
  assert.throws(() => gate.wrap('unknown', () => {}), /invalid qzone tool/);
});
