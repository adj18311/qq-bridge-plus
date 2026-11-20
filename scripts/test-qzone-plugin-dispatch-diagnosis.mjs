// t9 — DIAGNOSIS ONLY: which of the five `origin-unbound` exits actually fired.
//
// THE PROBLEM
// -----------
// `dispatchBound` refuses for five different internal reasons and answers the SAME object every
// time — correctly, because the model must not learn which gate refused. The cost is that the real
// incident (after a DSH restart, `qzone_read_posts` answered `origin-unbound`) could not be
// diagnosed from outside: "the event never arrived", "it arrived and we dropped it", "the ledger
// is gone" and "the epoch is stale" were indistinguishable.
//
// WHAT WAS ADDED, AND WHAT WAS NOT
// --------------------------------
// Added: a frozen reason vocabulary, one counter per reason, the last reason, and four
// non-identifying counters describing the `session/event` stream.
// NOT added: no new branch, no retry, no behaviour change. Every exit still returns exactly
// `{ ok: false, error: 'origin-unbound' }`, asserted byte-for-byte below.
//
// WHAT THIS TEST IS
// -----------------
// Fake Cordis ctx + fake runtime: the ctx double IS the host boundary being simulated. The REAL
// plugin entry, the real epoch/lifecycle bookkeeping, the real `session/event` handling and the
// real tool registry are exercised; only the host double and the runtime's `dispatch` are fakes.
//
// ⚠️ REAL DSH WAS NOT RESTARTED. This proves the diagnostics report the CORRECT reason when a
// given exit fires. It does NOT prove which exit fires in the production restart.
//
// ⚠️ EXIT 1 (`invalid-context`) IS NOT REACHABLE THROUGH THE TOOL SURFACE, and that is stated
// rather than papered over: `getQzoneDshSessionContext` (`plugins/qzone-safe/session-context.mjs`)
// refuses a non-string or out-of-charset session/call id with `missing-native-context` BEFORE
// `dispatchBound` is ever called, and that handler is `dispatchBound`'s only caller. The branch is
// kept (defence in depth) and its reason is in the closed vocabulary, but no end-to-end test can
// trigger it without changing the behaviour this task must not change. DG-1 asserts what is true:
// the reason exists in the vocabulary and the tool refuses earlier with its own error.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createQzonePluginHandle,
  DISPATCH_REFUSAL_REASONS,
  STATES,
} from '../plugins/qzone-safe/index.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const SESSION = 'session-diag';
const CALL_ID = 'call-diag';
const EPOCH = 'epoch-diag';
const FRIEND = 20002;

/** A ctx double that records listeners, so the real subscribers can be driven. */
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

/**
 * The runtime double. The plugin needs `dispatch` + `epoch`, and a `sourceLifetime` whose
 * `sourceEpoch()` answers the LIVE generation and whose `getLedger()` mints a REAL origin ledger —
 * `getLedger` is what the plugin calls from `ledgerFor`, and leaving it out turns every
 * `agent/created` into `adaptersFailed` instead of a usable ledger.
 */
function fakeRuntime({ epoch = EPOCH, liveEpoch = EPOCH } = {}) {
  const calls = [];
  return {
    calls,
    runtime: {
      epoch,
      dispatch: async (action, input, context) => {
        calls.push({ action, context });
        return { ok: true, reached: true };
      },
      sourceLifetime: {
        sourceEpoch: () => liveEpoch,
        getLedger: (sessionId) => createQzoneOriginLedger({ sessionId, epoch: EPOCH }),
      },
    },
  };
}

/** A handle over a fresh ctx. `liveEpoch` != `epoch` produces the superseded-generation case. */
async function makeHandle(t, options = {}) {
  const host = fakeCtx();
  const { runtime, calls } = fakeRuntime(options);
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: runtime.epoch,
    dispatch: runtime.dispatch,
    sourceLifetime: runtime.sourceLifetime,
    defineTool: (tool) => tool,
  });
  t.after(async () => { await handle.dispose(); });
  return { host, handle, calls };
}

/** The one tool handler `dispatchBound` sits behind — what the model actually calls. */
function executeReadPosts(host, callId = CALL_ID) {
  const tool = host.registered.get('qzone_read_posts');
  assert.ok(tool, '前提：qzone_read_posts 必须已注册');
  return tool.execute({ target_uin: FRIEND, pos: 0, num: 20 },
    { callId, agent: { session: { id: SESSION } } });
}

/** Emit one `session/event` tool/call, as the host does. */
function emitToolCall(host, { callId = CALL_ID, name = 'qzone_read_posts' } = {}) {
  host.emit('session/event', { id: SESSION }, { type: 'tool/call', data: { turn: 1, step: 1, callId, name } });
}

/** Emit `agent/created`, which is what installs the ledger and the pre-step adapter. */
function emitAgent(host, sessionId = SESSION) {
  host.emit('agent/created', {
    agent: { id: 'agent-diag', session: { id: sessionId }, ctx: { on: () => () => {} } },
  });
}

const REFUSAL = { ok: false, error: 'origin-unbound' };

// ── 1. the closed vocabulary, and the exit that cannot be reached end-to-end ────────────────
test('DG-1 原因词表是固定闭集；invalid-context 分支在工具面上不可达（如实记录，不硬造）', async (t) => {
  assert.deepEqual([...DISPATCH_REFUSAL_REASONS],
    ['invalid-context', 'epoch', 'position', 'ledger', 'consume'],
    '原因词表必须恰好是这 5 个固定常量，顺序即分支顺序');
  assert.equal(Object.isFrozen(DISPATCH_REFUSAL_REASONS), true, '词表必须冻结，不得运行时扩张');

  const { host, handle } = await makeHandle(t);
  assert.equal(handle.status().state, STATES.DISPATCH_READY, '前提：handle 必须就绪');
  assert.deepEqual(handle.status().lastDispatchRefusal, { reason: null, counters: {
    'invalid-context': 0, epoch: 0, position: 0, ledger: 0, consume: 0,
  } }, '新建的 handle 必须没有任何拒绝记录，且五个桶全为 0');

  // The tool surface refuses a malformed exec context ITSELF, before `dispatchBound` runs.
  const tool = host.registered.get('qzone_read_posts');
  for (const exec of [
    { callId: CALL_ID },                                   // no agent
    { callId: CALL_ID, agent: { session: {} } },           // no session id
    { callId: 42, agent: { session: { id: SESSION } } },   // non-string call id
    { callId: 'bad id!', agent: { session: { id: SESSION } } },
  ]) {
    const result = await tool.execute({ target_uin: FRIEND }, exec);
    assert.deepEqual(result, { ok: false, error: 'missing-native-context' },
      '非法 exec 必须在工具层被拒（missing-native-context），而不是走到 dispatchBound');
  }
  assert.equal(handle.status().lastDispatchRefusal.reason, null,
    '工具层的拒绝不得记入 dispatch 诊断 —— 它压根没到 dispatchBound');
});

// ── 2. each reachable exit reports its own reason, and the answer never changes ────────────
test('DG-2 epoch / position / ledger / consume 四个分支各自可区分，且对外返回值逐字节不变', async (t) => {
  // (a) EPOCH — a superseded generation. The position and the ledger are both irrelevant: the
  // generation check is the first thing after the context check.
  {
    const { host, handle } = await makeHandle(t, { epoch: 'epoch-old', liveEpoch: EPOCH });
    emitAgent(host);
    emitToolCall(host);
    const result = await executeReadPosts(host);
    assert.deepEqual(result, REFUSAL, 'epoch 分支对外必须仍是同一个 origin-unbound');
    assert.equal(handle.status().lastDispatchRefusal.reason, 'epoch', '必须记为 epoch');
    assert.deepEqual(handle.status().lastDispatchRefusal.counters,
      { 'invalid-context': 0, epoch: 1, position: 0, ledger: 0, consume: 0 },
      '只能命中 epoch 一个桶');
  }

  // (b) POSITION — nothing was ever observed for this (session, callId).
  {
    const { host, handle } = await makeHandle(t);
    emitAgent(host);  // ledger exists, so the refusal cannot be exit 4
    const result = await executeReadPosts(host);
    assert.deepEqual(result, REFUSAL, 'position 分支对外必须仍是同一个 origin-unbound');
    assert.equal(handle.status().lastDispatchRefusal.reason, 'position', '必须记为 position');
  }

  // (c) LEDGER — the event WAS observed (a position exists) but no ledger was ever built for the
  // session, because no agent was ever announced for it.
  {
    const { host, handle } = await makeHandle(t);
    emitToolCall(host);  // position stored; no agent => no ledger
    const result = await executeReadPosts(host);
    assert.deepEqual(result, REFUSAL, 'ledger 分支对外必须仍是同一个 origin-unbound');
    assert.equal(handle.status().lastDispatchRefusal.reason, 'ledger', '必须记为 ledger');
    assert.equal(handle.status().positionStream.positionsStored, 1,
      '前提对照：ledger 分支下 position 确实是存在的（否则测的会是 position）');
  }

  // (d) CONSUME — position and ledger both exist, but the ledger has no binding for this call:
  // the event arrived without the request/step it would have to cite.
  {
    const { host, handle } = await makeHandle(t);
    emitAgent(host);
    emitToolCall(host);
    const result = await executeReadPosts(host);
    assert.deepEqual(result, REFUSAL, 'consume 分支对外必须仍是同一个 origin-unbound');
    assert.equal(handle.status().lastDispatchRefusal.reason, 'consume', '必须记为 consume');
  }
});

// ── 3. the position branch split into its two real causes ──────────────────────────────────
test('DG-3 positionStream 能区分「事件从未到达」与「到达但没存」', async (t) => {
  // (a) nothing was delivered at all: the subscription-time question.
  {
    const { host, handle } = await makeHandle(t);
    emitAgent(host);
    const result = await executeReadPosts(host);
    assert.equal(handle.status().lastDispatchRefusal.reason, 'position');
    const stream = handle.status().positionStream;
    assert.deepEqual(
      { seen: stream.toolCallEventsSeen, stored: stream.positionsStored, live: stream.positionsLive },
      { seen: 0, stored: 0, live: 0 },
      '事件一条都没到：seen=0 直接指向订阅/时序问题',
    );
    assert.deepEqual(result, REFUSAL);
  }

  // (b) the event arrived and was stored.
  {
    const { host, handle } = await makeHandle(t);
    emitAgent(host);
    emitToolCall(host);
    await executeReadPosts(host);
    const stream = handle.status().positionStream;
    assert.equal(stream.toolCallEventsSeen, 1, '必须看到 1 个 tool/call 事件');
    assert.equal(stream.positionsStored, 1, '必须存下 1 个 position');
    assert.equal(stream.positionsSkippedForeignTool, 0, 'qzone_* 名字不得被名字过滤掉');
    assert.equal(stream.positionsSkippedInvalidId, 0, '合法 id 不得被 id 过滤掉');
  }

  // (c) the event arrived but was dropped by the NAME filter: seen>0, stored=0, foreign=1.
  {
    const { host, handle } = await makeHandle(t);
    emitAgent(host);
    emitToolCall(host, { callId: 'call-other-tool', name: 'bash' });
    const result = await executeReadPosts(host);
    assert.equal(handle.status().lastDispatchRefusal.reason, 'position');
    const stream = handle.status().positionStream;
    assert.deepEqual(
      { seen: stream.toolCallEventsSeen, stored: stream.positionsStored, foreign: stream.positionsSkippedForeignTool },
      { seen: 1, stored: 0, foreign: 1 },
      '「收到 N 条但存了 0 条」必须由 foreign 计数直接指出原因',
    );
    assert.deepEqual(result, REFUSAL);
  }

  // (d) the event arrived but the ID shape was rejected: seen>0, stored=0, invalidId=1.
  {
    const { host, handle } = await makeHandle(t);
    emitAgent(host);
    host.emit('session/event', { id: SESSION }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'bad id!', name: 'qzone_read_posts' } });
    const stream = handle.status().positionStream;
    assert.equal(stream.toolCallEventsSeen, 1, '事件必须被看到');
    assert.equal(stream.positionsStored, 0, '非法 id 不得存 position');
    assert.equal(stream.positionsSkippedInvalidId, 1, '必须记为 id 过滤');
  }
});

// ── 4. no identifiers anywhere in the new diagnostics ─────────────────────────────────────
test('DG-4 无标识：新增诊断里搜不到 sessionId / callId', async (t) => {
  const { host, handle } = await makeHandle(t);
  emitAgent(host);
  emitToolCall(host);
  await executeReadPosts(host);

  const status = handle.status();
  const diagnostics = JSON.stringify({
    lastDispatchRefusal: status.lastDispatchRefusal,
    positionStream: status.positionStream,
  });
  assert.equal(diagnostics.includes(SESSION), false,
    '新增诊断不得包含 sessionId: ' + diagnostics);
  assert.equal(diagnostics.includes(CALL_ID), false,
    '新增诊断不得包含 callId: ' + diagnostics);
  assert.equal(diagnostics.includes(FRIEND), false, '新增诊断不得包含 QQ 号');
  assert.equal(JSON.stringify(status).includes(CALL_ID), false,
    '整个 status() 里也不得出现 callId');

  // ⚠️ STATED, NOT GLOSSED OVER: the WHOLE status object legitimately contains session ids in
  // `dispatchableSessions`, which is a PRE-EXISTING field this task must not change. So the
  // whole-object assertion is scoped to call ids (which are exposed nowhere); the session-id
  // assertion is scoped to the NEW fields, which is what this task added.
  assert.equal(typeof status.dispatchableSessions, 'object', '对照：dispatchableSessions 仍然存在');
  assert.deepEqual(Object.keys(status.lastDispatchRefusal).sort(), ['counters', 'reason'],
    'lastDispatchRefusal 的键集必须固定');
  assert.deepEqual(Object.keys(status.positionStream).sort(),
    ['positionsEvictedLive', 'positionsLive', 'positionsSkippedForeignTool', 'positionsSkippedInvalidId', 'positionsStored', 'toolCallEventsSeen'],
    'positionStream 的键集必须固定（只加计数，不加标识）');
});

// ── 5. only the LAST reason is kept, and only the closed buckets are counted ────────────────
test('DG-5 只记最近一次原因；计数只落在闭集桶里', async (t) => {
  const { host, handle } = await makeHandle(t);
  emitAgent(host);
  await executeReadPosts(host, 'call-a');           // position
  emitToolCall(host, { callId: 'call-b' });
  await executeReadPosts(host, 'call-b');           // consume
  const status = handle.status();
  assert.equal(status.lastDispatchRefusal.reason, 'consume', '必须只保留最近一次原因');
  assert.deepEqual(status.lastDispatchRefusal.counters,
    { 'invalid-context': 0, epoch: 0, position: 1, ledger: 0, consume: 1 },
    '两个桶各记一次，其余保持 0；不得出现第 6 个桶');
  assert.equal(Object.keys(status.lastDispatchRefusal.counters).length, 5,
    '计数桶数量必须恒等于词表长度');
});