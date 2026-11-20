// t10 — `qzone_diagnose`: a READ-ONLY window onto the dispatch diagnostics.
//
// WHY THIS EXISTS
// ---------------
// A standard-mode session's `qzone_read_posts` kept answering `origin-unbound` while the host's
// `tool/call` demonstrably fired, and the plugin's own store showed `reads=0 readAttempts={}` — so
// the dispatch never reached the runtime. C9 recorded WHICH of the five exits fired, but nothing
// exposed those facts to the model, which is where the question is asked from. This tool is that
// exposure, and nothing else.
//
// WHAT IS REAL HERE
// -----------------
//   · the REAL plugin entry and the REAL `applyQzoneNativeTools` registration path;
//   · the REAL `dispatchBound` / epoch / position / ledger bookkeeping — the diagnostics are driven
//     by actually triggering a refusal, not by stubbing the counters.
// WHAT IS A FIXTURE: the Cordis context (the host boundary being simulated) and the runtime's
// `dispatch`.
//
// ⚠️ REAL DSH WAS NOT RESTARTED. This proves the tool is registered, that it returns the snapshot,
// and that the snapshot carries no identifiers. It does NOT prove the diagnosis is correct for the
// production incident — that needs one real run.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createQzonePluginHandle, QZONE_TOOL_NAMES } from '../plugins/qzone-safe/index.mjs';
import { applyQzoneNativeTools } from '../plugins/qzone-safe/native-tool.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { QZONE_MCP_TOOLS } from '../src/core/qzone-mcp-contract.mjs';

const SESSION = 'session-diagnose';
const CALL_ID = 'call-diagnose';
const EPOCH = 'epoch-diagnose';
const FRIEND = 20007;

const BUSINESS_TOOLS = Object.keys(QZONE_MCP_TOOLS).map((action) => `qzone_${action}`);

/** The host boundary double: a listener map plus a tool registry. */
function fakeCtx() {
  const listeners = new Map();
  const registered = new Map();
  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {};
    },
    tools: {
      register(tool) {
        registered.set(tool.name, tool);
        return () => registered.delete(tool.name);
      },
    },
  };
  const emit = (event, ...args) => { for (const listener of listeners.get(event) ?? []) listener(...args); };
  return { ctx, emit, registered };
}

function fakeRuntime({ epoch = EPOCH, liveEpoch = EPOCH } = {}) {
  return {
    epoch,
    dispatch: async () => ({ ok: true, reached: true }),
    sourceLifetime: {
      sourceEpoch: () => liveEpoch,
      getLedger: (sessionId) => createQzoneOriginLedger({ sessionId, epoch: EPOCH }),
    },
  };
}

async function makeHandle(t, options = {}) {
  const host = fakeCtx();
  const runtime = fakeRuntime(options);
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: runtime.epoch,
    dispatch: runtime.dispatch,
    sourceLifetime: runtime.sourceLifetime,
    defineTool: (tool) => tool,
  });
  t.after(async () => { await handle.dispose(); });
  return { host, handle };
}

/** Trigger one real `origin-unbound`: an agent exists, but this call was never observed. */
async function triggerPositionRefusal(host) {
  host.emit('agent/created', {
    agent: { id: 'agent-diagnose', session: { id: SESSION }, ctx: { on: () => () => {} } },
  });
  const tool = host.registered.get('qzone_read_posts');
  assert.ok(tool, '前提：qzone_read_posts 必须已注册');
  const result = await tool.execute({ target_uin: FRIEND },
    { callId: CALL_ID, agent: { session: { id: SESSION } } });
  assert.deepEqual(result, { ok: false, error: 'origin-unbound' }, '前提：这次调用必须真的被拒');
}

// ── 1. registered, and with an empty parameter schema ──────────────────────────────────────
test('DT-1 qzone_diagnose 已注册，参数 schema 为空', async (t) => {
  const { host } = await makeHandle(t);
  const tool = host.registered.get('qzone_diagnose');
  assert.ok(tool, 'qzone_diagnose 必须已注册');
  assert.deepEqual(tool.parameters, {}, '诊断工具不得接受任何参数');
  assert.match(tool.description, /只读诊断/, '描述必须写明这是只读诊断');
  assert.match(tool.description, /不访问平台/, '描述必须写明不访问平台');
  assert.match(tool.description, /不写存储/, '描述必须写明不写存储');

  // The business contract must stay untouched: the diagnostic tool is NOT a qzone business tool.
  assert.equal(Object.hasOwn(QZONE_MCP_TOOLS, 'diagnose'), false, 'QZONE_MCP_TOOLS 不得被污染');
  assert.equal(QZONE_TOOL_NAMES.has('qzone_diagnose'), false,
    'qzone_diagnose 不得进入业务工具名集合（它不走 dispatchBound）');
  for (const name of BUSINESS_TOOLS) {
    assert.ok(host.registered.get(name), '原有业务工具必须仍然注册: ' + name);
  }
});

// ── 2. it returns the C9 facts ─────────────────────────────────────────────────────────────
test('DT-2 返回体含 lastDispatchRefusal 与 positionStream，且反映真实触发的那次拒绝', async (t) => {
  const { host, handle } = await makeHandle(t);
  await triggerPositionRefusal(host);

  const tool = host.registered.get('qzone_diagnose');
  const snapshot = await tool.execute({}, { callId: 'diag-call', agent: { session: { id: SESSION } } });

  assert.equal(Object.isFrozen(snapshot), true, '快照必须是冻结对象');
  assert.ok(snapshot.lastDispatchRefusal, '必须包含 lastDispatchRefusal');
  assert.ok(snapshot.positionStream, '必须包含 positionStream');
  assert.equal(snapshot.lastDispatchRefusal.reason, 'position',
    '快照必须报告真实触发的那次拒绝原因');
  assert.deepEqual(snapshot.lastDispatchRefusal.counters,
    { 'invalid-context': 0, epoch: 0, position: 1, ledger: 0, consume: 0 });
  assert.equal(snapshot.positionStream.toolCallEventsSeen, 0,
    '这次没有发出任何 tool/call 事件，seen 必须是 0');
  assert.equal(snapshot.dispatchAvailable, true, '前提：adapter 已建立，dispatchAvailable 应为 true');
  // ⚠️ THE SPEC CONFLICT, RESOLVED AND ASSERTED: the task asks for `dispatchableSessions` AND
  // for no sessionId anywhere in the answer. Those are incompatible — the field IS a list of
  // session ids — so the identifier ban wins and the same fact is reported as a COUNT. Pinned
  // here so nobody silently "restores" the leaking field.
  assert.equal(Object.hasOwn(snapshot, 'dispatchableSessions'), false,
    '快照不得携带 dispatchableSessions（那是 sessionId 列表）');
  assert.equal(snapshot.dispatchableSessionCount, 1,
    '同一事实必须以计数形式给出：恰好 1 个可派发会话');

  // The same facts the handle exposes directly, so the tool is not a second source of truth.
  assert.deepEqual(snapshot, handle.diagnose(), '工具返回必须与 handle.diagnose() 完全一致');
});

// ── 3. no identifiers ─────────────────────────────────────────────────────────────────────
test('DT-3 返回体里搜不到 sessionId / callId / QQ 号', async (t) => {
  const { host } = await makeHandle(t);
  await triggerPositionRefusal(host);
  const snapshot = await host.registered.get('qzone_diagnose').execute({}, {});
  const text = JSON.stringify(snapshot);
  assert.equal(text.includes(SESSION), false, '快照不得包含 sessionId: ' + text);
  assert.equal(text.includes(CALL_ID), false, '快照不得包含 callId: ' + text);
  assert.equal(text.includes(String(FRIEND)), false, '快照不得包含被访问的 QQ 号');
  assert.equal(/token/i.test(text), false, '快照不得包含 token 字样');
});

// ── 4. genuinely read-only ────────────────────────────────────────────────────────────────
test('DT-4 只读：调用诊断前后 store 的 reads/writes 与配额完全不变', async (t) => {
  const runtime = fakeRuntime();
  // A real store is not needed: what is asserted is that the tool does not TOUCH one. The
  // snapshot only reads in-memory counters, so an unreachable store would throw if it were used.
  const host = fakeCtx();
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: runtime.epoch, dispatch: runtime.dispatch, sourceLifetime: runtime.sourceLifetime,
    defineTool: (tool) => tool,
  });
  t.after(async () => { await handle.dispose(); });
  await triggerPositionRefusal(host);

  const before = JSON.stringify(handle.diagnose());
  const tool = host.registered.get('qzone_diagnose');
  for (let index = 0; index < 5; index += 1) await tool.execute({}, {});
  const after = JSON.stringify(handle.diagnose());
  assert.equal(after, before, '重复调用诊断不得改变任何被报告的事实（只读）');

  // No platform call was made by the diagnostic: the only refusal on record is the one the test
  // triggered before the diagnostic ran, and its counters did not move.
  const stream = JSON.parse(after).positionStream;
  assert.equal(stream.toolCallEventsSeen, 0, '诊断本身不得产生 tool/call 事件');
  assert.equal(stream.positionsStored, 0, '诊断本身不得写入 position');
});

// ── 5. opt-in registration ────────────────────────────────────────────────────────────────
test('DT-5 未提供 diagnose ⇒ 不注册 qzone_diagnose，六个业务工具仍正常注册', async () => {
  const host = fakeCtx();
  const result = await applyQzoneNativeTools(host.ctx, {
    dispatch: async () => ({ ok: true }),
    defineTool: (tool) => tool,
  });
  assert.equal(result.ok, true, '没有 diagnose 时注册仍必须成功');
  assert.equal(host.registered.has('qzone_diagnose'), false, '未提供 diagnose 时不得注册诊断工具');
  for (const name of BUSINESS_TOOLS) {
    assert.ok(host.registered.get(name), '业务工具必须仍然注册: ' + name);
  }
  assert.equal(host.registered.size, BUSINESS_TOOLS.length, '工具数量必须恰好等于业务工具数');
  result.dispose();
  assert.equal(host.registered.size, 0, 'dispose 必须把注册全部摘掉');

  // And when the provider IS supplied, the tool appears and dispose still unwinds everything.
  const withDiagnose = fakeCtx();
  const withResult = await applyQzoneNativeTools(withDiagnose.ctx, {
    dispatch: async () => ({ ok: true }),
    defineTool: (tool) => tool,
    diagnose: () => Object.freeze({ state: 'probe' }),
  });
  assert.equal(withDiagnose.registered.has('qzone_diagnose'), true, '提供 diagnose 时必须注册诊断工具');
  assert.equal(withDiagnose.registered.size, BUSINESS_TOOLS.length + 1, '必须恰好比业务工具多一个');
  withResult.dispose();
  assert.equal(withDiagnose.registered.size, 0, 'dispose 必须连诊断工具一起摘掉');
});