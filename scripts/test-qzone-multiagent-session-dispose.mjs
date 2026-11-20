// Pins R12-4: TWO agents on ONE session must both be able to dispatch, and disposing
// one of them must not disable the other or the session.
//
// The defect this replaces, reproduced with a real handle + real ledger + real execute:
//
//   one agent            turn1 {ok:true}  turn2 {ok:true}   ledger alive
//   add a second agent   agentAdapters = 2
//     next turn          {ok:false, error:'origin-unbound'}   ← duplicate observeToolCall
//                        ledger.alive() = false               ← duplicate endTurn
//     next turn          threw "来源账本不可用或已满"          ← session permanently dead
//     status             dispatchAvailable: true              ← still promising
//
// The cause was `session/event` being observed once per AGENT while it is HOST-scoped:
// both adapters recorded the same `tool/call` (poisoning the callId via `spentCalls`) and
// the same `turn/end` (the second `endTurn` returns false, and the adapter's fault branch
// disconnects the SHARED ledger). The fix gives each session exactly ONE observer.
//
// Crucial non-goal, pinned at the bottom: this must NOT become event deduplication.
// A genuinely replayed `tool/call` still has to reach the ledger and be refused by the
// ledger's own replay protection; filtering it in the observer would hide a conflict.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';
import { createQzoneSourceLifetime } from '../src/core/qzone-source-lifetime-offline.mjs';

const TOOL = 'qzone_read_posts';
const A = 'sess-shared';
const B = 'sess-other';
const defineTool = (tool) => tool;
const execFor = (sessionId, callId) => ({ agent: { session: { id: sessionId } }, callId });
const userMessage = (requestId) => ({ role: 'user', source: { rpcId: requestId } });

// Listener counting is how "exactly ONE session observer" and "the observer was really
// torn down" are checked without reaching into the plugin's private Map. It is a host-visible
// fact (the number of subscriptions the plugin leaves behind on the host context), not an
// implementation detail: a leaked observer is a permanent listener on the host.
const HOST_EVENTS = ['session/event', 'agent/created', 'agent/disposed'];

function fakeHost() {
  const listeners = new Map();
  const registered = new Map();
  return {
    registered,
    ctx: {
      on(name, fn) {
        const list = listeners.get(name) ?? [];
        list.push(fn);
        listeners.set(name, list);
        return () => {
          const index = list.indexOf(fn);
          if (index >= 0) list.splice(index, 1);
        };
      },
      tools: { register: (tool) => { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
    },
    emit(name, ...args) { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args); },
    count(name) { return (listeners.get(name) ?? []).length; },
    counts() { return Object.fromEntries(HOST_EVENTS.map((name) => [name, (listeners.get(name) ?? []).length])); },
  };
}

// Per-agent ctx: pre-step lives here. Storing the listeners (and firing them) is what
// makes this a real test rather than the empty assertion R12-2 found.
//
// `broken: true` returns `undefined` from `on` — the shape of a host ctx that cannot
// hand back a disposer. `createQzonePrestepAdapter` validates that and throws, which is
// the adapter-construction failure path (R12-4 D: creation failure).
function agentCtx({ broken = false } = {}) {
  const callbacks = new Map();
  return {
    on(name, fn) {
      if (broken) return undefined;
      const list = callbacks.get(name) ?? []; list.push(fn); callbacks.set(name, list); return () => {};
    },
    fire(name, payload) { for (const fn of callbacks.get(name) ?? []) fn(payload, () => {}); },
    listenerCount(name) { return (callbacks.get(name) ?? []).length; },
    listenerNames() { return [...callbacks.keys()]; },
  };
}

let turnCounter = 0;

async function world() {
  const lifetime = createQzoneSourceLifetime({ sessionLimit: 8, trackingLimit: 64 });
  const host = fakeHost();
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    dispatch: async () => ({ ok: true }),
    epoch: lifetime.sourceEpoch(),
    sourceLifetime: lifetime,
    defineTool,
  });
  return { lifetime, host, handle };
}

function createAgent(host, agentId, sessionId, options) {
  const ctxOf = agentCtx(options);
  host.emit('agent/created', { agent: { id: agentId, session: { id: sessionId }, ctx: ctxOf } });
  return ctxOf;
}

// The plugin subscribes to `session/event` itself (to build dispatch positions) and each
// session gets ONE observer on the same host event. So the expected host listener count is
// `1 + (number of sessions with a live observer)`. Written as an expression, it keeps every
// assertion honest about *which* listener is the observer instead of hard-coding a number.
const pluginOwnSessionEventListeners = 1;

// One complete turn: tool runs INSIDE the turn, `turn/end` after it (see
// `test-qzone-agent-resume.mjs` for why the order matters).
async function armAndRun(w, sessionId, ctxOf, { requestId, callId }) {
  turnCounter += 1;
  const turn = turnCounter;
  try { w.handle.registerBridgeRequest(sessionId, { requestId, origin: 'qq-inbound' }); }
  catch (error) { return { stage: 'register', threw: error.message }; }
  ctxOf.fire('agent/pre-step', { turn, step: 1, messages: [userMessage(requestId)] });
  w.host.emit('session/event', { id: sessionId }, { type: 'tool/call', data: { turn, step: 1, callId, name: TOOL } });
  const result = await w.host.registered.get(TOOL).execute({ target_uin: 456 }, execFor(sessionId, callId));
  w.host.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn } });
  return { result };
}

test('两个 agent 同 session：都能派发，不会再被对方的观察记账污染', async () => {
  const w = await world();
  const ctxA = createAgent(w.host, 'agent-A', A);

  // Before the second agent: the control that proves the harness is sound.
  assert.deepEqual((await armAndRun(w, A, ctxA, { requestId: 'r-1', callId: 'c-1' })).result, { ok: true });

  const ctxB = createAgent(w.host, 'agent-B', A);
  assert.equal(w.handle.status(A).agentAdapters, 2, '前提：两个 agent 真的都装上了 adapter');

  // The turn that used to fail `origin-unbound` because the second adapter poisoned it.
  assert.deepEqual((await armAndRun(w, A, ctxA, { requestId: 'r-2', callId: 'c-2' })).result, { ok: true },
    '第二个 agent 存在时，第一个 agent 仍然必须能派发');
  assert.deepEqual((await armAndRun(w, A, ctxB, { requestId: 'r-3', callId: 'c-3' })).result, { ok: true },
    '第二个 agent 自己也必须能派发');

  assert.equal(w.lifetime.getLedger(A).alive(), true, '共享账本不得因为重复 endTurn 被打成 continuityLost');
  assert.equal(w.handle.status(A).dispatchAvailable, true);
  assert.equal(w.handle.status(A).adaptersDisconnected, 0, '没有运行期故障，计数器必须为 0');
  await w.handle.dispose();
});

test('退出其中一个 agent：剩下的继续可派发，账本不被替换也不被打断', async () => {
  const w = await world();
  const ctxA = createAgent(w.host, 'agent-A', A);
  const ctxB = createAgent(w.host, 'agent-B', A);
  assert.deepEqual((await armAndRun(w, A, ctxA, { requestId: 'r-1', callId: 'c-1' })).result, { ok: true });

  const shared = w.lifetime.getLedger(A);
  w.host.emit('agent/disposed', { agent: { id: 'agent-A', session: { id: A } } });

  assert.equal(w.lifetime.getLedger(A), shared, '还有 agent 用着这本账本时不得替换');
  assert.equal(w.lifetime.getLedger(A).alive(), true, '退出一个 agent 不得断掉共享账本');
  assert.equal(w.handle.status(A).dispatchAvailable, true, '剩下的 agent 必须仍然可派发');
  assert.deepEqual((await armAndRun(w, A, ctxB, { requestId: 'r-2', callId: 'c-2' })).result, { ok: true },
    '退出一个 agent 之后，另一个必须真的还能派发');

  await w.handle.dispose();
});

test('最后一个 agent 退出后同 session 恢复：换新账本并继续可派发', async () => {
  const w = await world();
  const ctxA = createAgent(w.host, 'agent-A', A);
  const ctxB = createAgent(w.host, 'agent-B', A);
  const shared = w.lifetime.getLedger(A);

  w.host.emit('agent/disposed', { agent: { id: 'agent-A', session: { id: A } } });
  assert.equal(w.lifetime.getLedger(A), shared, '还剩 agent 时不释放');

  w.host.emit('agent/disposed', { agent: { id: 'agent-B', session: { id: A } } });
  assert.notEqual(w.lifetime.getLedger(A), shared, '最后一个 agent 退出后必须换一本新账本');
  assert.equal(w.handle.status(A).dispatchAvailable, false, '没有 agent 了就不该报可派发');

  const ctxC = createAgent(w.host, 'agent-C', A);
  assert.equal(w.handle.status(A).dispatchAvailable, true, '重新创建 agent 后必须恢复可派发');
  assert.deepEqual((await armAndRun(w, A, ctxC, { requestId: 'r-1', callId: 'c-1' })).result, { ok: true },
    '恢复之后必须真的能派发');
  await w.handle.dispose();
});

test('别的 session 不受影响：A 的 agent 共享与退出都不能波及 B', async () => {
  const w = await world();
  const ctxA1 = createAgent(w.host, 'agent-A1', A);
  createAgent(w.host, 'agent-A2', A);
  const ctxB = createAgent(w.host, 'agent-B1', B);
  const ledgerB = w.lifetime.getLedger(B);

  assert.deepEqual((await armAndRun(w, B, ctxB, { requestId: 'r-b1', callId: 'c-b1' })).result, { ok: true });
  w.host.emit('agent/disposed', { agent: { id: 'agent-A1', session: { id: A } } });
  w.host.emit('agent/disposed', { agent: { id: 'agent-A2', session: { id: A } } });

  assert.equal(w.lifetime.getLedger(B), ledgerB, 'B 的账本不得因为 A 的 agent 退出被替换');
  assert.equal(w.handle.status(B).dispatchAvailable, true);
  assert.deepEqual((await armAndRun(w, B, ctxB, { requestId: 'r-b2', callId: 'c-b2' })).result, { ok: true },
    'A 上的任何变动都不得影响 B 的派发');
  void ctxA1;
  await w.handle.dispose();
});

test('不是事件去重：重放的 tool/call 仍必须走到账本并被拒', async () => {
  const w = await world();
  const ctxA = createAgent(w.host, 'agent-A', A);
  createAgent(w.host, 'agent-B', A);

  turnCounter += 1;
  const turn = turnCounter;
  w.handle.registerBridgeRequest(A, { requestId: 'r-1', origin: 'qq-inbound' });
  ctxA.fire('agent/pre-step', { turn, step: 1, messages: [userMessage('r-1')] });
  w.host.emit('session/event', { id: A }, { type: 'tool/call', data: { turn, step: 1, callId: 'c-1', name: TOOL } });

  assert.deepEqual(await w.host.registered.get(TOOL).execute({ target_uin: 456 }, execFor(A, 'c-1')), { ok: true },
    '前提：第一次派发成功');

  // A genuinely replayed host event for the SAME callId. The observer must forward it —
  // dropping it here would be deduplication at the wrong layer, hiding a real conflict —
  // and the ledger's own `spentCalls` must refuse the second binding.
  w.host.emit('session/event', { id: A }, { type: 'tool/call', data: { turn, step: 1, callId: 'c-1', name: TOOL } });
  assert.equal(w.lifetime.getLedger(A).peekCall('c-1'), null,
    '重放的 callId 必须被账本自己的防重放拦下（observer 不得替它去重）');
  assert.deepEqual(await w.host.registered.get(TOOL).execute({ target_uin: 456 }, execFor(A, 'c-1')),
    { ok: false, error: 'origin-unbound' }, '重放不得拿到第二次绑定');
  await w.handle.dispose();
});

test('账本死亡时状态立即如实反映：不得再报可派发', async () => {
  const w = await world();
  const ctxA = createAgent(w.host, 'agent-A', A);
  assert.equal(w.handle.status(A).dispatchAvailable, true);

  // A malformed pre-step is a genuine fault, not a sharing artefact: it must latch.
  ctxA.fire('agent/pre-step', { turn: 0, step: 1, messages: [] });
  assert.equal(w.lifetime.getLedger(A).alive(), false, '前提：账本确实被打成 continuityLost');

  const status = w.handle.status(A);
  assert.equal(status.dispatchAvailable, false, '账本死了就必须报不可派发');
  assert.deepEqual(status.dispatchableSessions, []);
  assert.equal(status.adaptersDisconnected, 1, '故障必须被计数');

  // And the promise must stay honest when a NEW agent arrives on that dead session.
  createAgent(w.host, 'agent-B', A);
  assert.equal(w.handle.status(A).dispatchAvailable, false, '死账本上新建 agent 也不得报可派发');
  assert.equal(w.handle.status(A).adaptersBlocked, 1, '被拒的装配必须可观察');
  await w.handle.dispose();
});

// ── R12-4 C (Codex finding 3): fault propagation must fail CLOSED ────────────────
//
// Codex: "状态须 fail-closed：核查单 agent adapter 故障使共享 ledger 失效时其他 entry 仍可能
// 报可派发；修复故障传播与生命周期，并检查 ledger/observer 实际存活。"
//
// The defect: `disconnect()` latches `continuityLost` on the ONE frozen ledger every agent
// on the session shares, but the plugin only marked the FAULTING entry dead. The survivor's
// entry stayed "alive", `liveAdapterSessions()` kept the session in `dispatchableSessions`,
// and `status()` promised a dispatch that `ledger.consume` refused. The fix is
// `faultSession(sessionId)`: latch every entry on that session, count the fault ONCE.
//
// These three tests pin the fix by BEHAVIOUR, not by reading the plugin's private map:
// the survivor's entry is proven dead by it being unable to dispatch after the faulting
// agent is gone, and by the session leaving `dispatchableSessions` while it is still there.

test('C1 共享账本故障必须 fail-closed：一个 agent 的畸形 pre-step 要打死同 session 所有 entry', async () => {
  const w = await world();
  const ctxA = createAgent(w.host, 'agent-A', A);
  const ctxB = createAgent(w.host, 'agent-B', A);
  assert.equal(w.handle.status(A).agentAdapters, 2, '前提：两个 agent 都装上了 adapter');
  assert.equal(w.handle.status(A).dispatchAvailable, true, '前提：故障之前真的可派发');

  // Only A receives malformed input. The consequence is LEDGER-scoped, because A and B
  // share one frozen ledger and `disconnect()` latches `continuityLost` on it for good.
  ctxA.fire('agent/pre-step', { turn: 0, step: 1, messages: [] });

  assert.equal(w.lifetime.getLedger(A).alive(), false, '前提：共享账本真的被打成 continuityLost');
  const status = w.handle.status(A);
  assert.equal(status.dispatchAvailable, false, '一个 agent 的故障之后，session 不得再报可派发');
  assert.ok(!status.dispatchableSessions.includes(A), '死 session 不得出现在 dispatchableSessions 里');
  assert.equal(status.adaptersDisconnected, 1, '一次故障只计一次，不按 entry 数量计');

  // The survivor must ALSO be latched dead. Disposing the faulting agent leaves exactly
  // one entry in `adapters`; if that entry were still "live", `liveAdapterSessions()`
  // would report the session as dispatchable even though every consume fails.
  w.host.emit('agent/disposed', { agent: { id: 'agent-A', session: { id: A } } });
  assert.equal(w.handle.status(A).agentAdapters, 1, '前提：幸存者 B 的 entry 仍在表里');
  const survived = w.handle.status(A);
  assert.equal(survived.dispatchAvailable, false,
    '幸存者 B 的 entry 也必须被标 dead，否则它会让 status 继续报可派发');
  assert.ok(!survived.dispatchableSessions.includes(A));

  // And B really cannot dispatch: the ledger refuses to even register a new bridge request.
  const attempted = await armAndRun(w, A, ctxB, { requestId: 'r-after-fault', callId: 'c-after-fault' });
  assert.equal(attempted.stage, 'register', '幸存者不得拿到新的 request 登记');
  assert.match(attempted.threw, /来源账本不可用或已满/u, '拒绝必须来自账本本身，而不是静默失败');
  assert.equal(w.handle.status(A).adaptersDisconnected, 1, '派发失败不得再叠加故障计数');
  await w.handle.dispose();
});

test('C2 observer 每 session 只创建一次，最后一个 agent 退出后必须真的被销毁', async () => {
  const w = await world();
  // Baseline: the plugin's own `session/event` subscription (positions), and nothing else.
  assert.equal(w.host.count('session/event'), 1, '前提：没有 agent 时只有插件自己的 host 订阅');

  const ctxA = createAgent(w.host, 'agent-A', A);
  assert.equal(w.host.count('session/event'), 2, '第一个 agent 必须创建本 session 的 observer');

  const ctxB = createAgent(w.host, 'agent-B', A);
  assert.equal(w.host.count('session/event'), 2,
    '第二个 agent 必须复用同一个 observer：每 agent 一个就是 R12-4 的缺陷本身');

  // Behavioural proof that one host event is recorded ONCE: a second recording of the same
  // callId would hit `spentCalls` and poison it, so `peekCall` would read null.
  w.handle.registerBridgeRequest(A, { requestId: 'r-1', origin: 'qq-inbound' });
  turnCounter += 1;
  const onceTurn = turnCounter;
  ctxA.fire('agent/pre-step', { turn: onceTurn, step: 1, messages: [userMessage('r-1')] });
  w.host.emit('session/event', { id: A }, { type: 'tool/call', data: { turn: onceTurn, step: 1, callId: 'c-once', name: TOOL } });
  assert.deepEqual(w.lifetime.getLedger(A).peekCall('c-once'), { turn: onceTurn, step: 1 },
    '一条 tool/call 只能被记一次：重复记录会毒化 callId 并让 peekCall 读成 null');
  w.host.emit('session/event', { id: A }, { type: 'turn/end', data: { turn: onceTurn } });

  // Last agent leaves: the session observer must be destroyed, not left on the host.
  w.host.emit('agent/disposed', { agent: { id: 'agent-A', session: { id: A } } });
  assert.equal(w.host.count('session/event'), 2, '还剩一个 agent 时 observer 必须继续存在');
  w.host.emit('agent/disposed', { agent: { id: 'agent-B', session: { id: A } } });
  assert.equal(w.host.count('session/event'), 1, '最后一个 agent 退出后 observer 必须被销毁');

  // Re-creating on the same session builds a NEW observer and that observer must work.
  const ctxC = createAgent(w.host, 'agent-C', A);
  assert.equal(w.host.count('session/event'), 2, '重建 agent 必须重建 observer');
  assert.deepEqual((await armAndRun(w, A, ctxC, { requestId: 'r-2', callId: 'c-2' })).result, { ok: true },
    '新 observer 必须真的能观察并派发');
  await w.handle.dispose();
  assert.equal(w.host.count('session/event'), 0, 'handle.dispose() 必须把 observer 一起带走');
});

test('C3 账本被 observer 打死 ≠ 被 releaseLedger 替换：前者不得因新建 agent 复活', async () => {
  // (a) A ledger killed by an observer fault is kept, stays dead, and blocks new agents.
  const killed = await world();
  const ctxA = createAgent(killed.host, 'agent-A', A);
  createAgent(killed.host, 'agent-B', A);
  const doomed = killed.lifetime.getLedger(A);
  // `turn/end` for a turn that is not in flight: `endTurn` returns false, and the
  // observer's fault branch latches the ledger. This is the observer-scoped fault path.
  killed.host.emit('session/event', { id: A }, { type: 'turn/end', data: { turn: 0 } });
  assert.equal(doomed.alive(), false, '前提：observer 故障真的打死了账本');
  assert.equal(killed.handle.status(A).dispatchAvailable, false);
  assert.equal(killed.handle.status(A).adaptersDisconnected, 1);

  killed.host.emit('agent/disposed', { agent: { id: 'agent-A', session: { id: A } } });
  killed.host.emit('agent/disposed', { agent: { id: 'agent-B', session: { id: A } } });
  assert.equal(killed.lifetime.getLedger(A), doomed,
    '故障账本不得被 releaseLedger 替换：spentCalls/usedRequests 是唯一的跨故障防重放证据');
  assert.equal(killed.lifetime.getLedger(A).alive(), false, '故障账本不得复活');
  assert.equal(killed.host.count('session/event'), 1, '故障 session 的 observer 也必须被清理');

  createAgent(killed.host, 'agent-C', A);
  const blocked = killed.handle.status(A);
  assert.equal(blocked.dispatchAvailable, false, '死账本上新建 agent 不得报可派发');
  assert.deepEqual(blocked.dispatchableSessions, []);
  assert.equal(blocked.adaptersBlocked, 1, '被拒的装配必须计数（不是 adaptersFailed）');
  assert.equal(blocked.agentAdapters, 0, '被拒的 agent 不得进入 adapters 表');
  assert.equal(killed.host.count('session/event'), pluginOwnSessionEventListeners,
    '被拒的 agent 不得留下 observer：它没有可服务的 adapter');
  const faultedState = {
    replacedLedger: killed.lifetime.getLedger(A) === doomed,
    ledgerAlive: killed.lifetime.getLedger(A).alive(),
    adaptersBlocked: killed.handle.status(A).adaptersBlocked,
  };
  await killed.handle.dispose();

  // (b) A ledger released on a CLEAN boundary is a different state: replaced and alive.
  const clean = await world();
  const ctxD = createAgent(clean.host, 'agent-D', A);
  const original = clean.lifetime.getLedger(A);
  clean.host.emit('agent/disposed', { agent: { id: 'agent-D', session: { id: A } } });
  assert.notEqual(clean.lifetime.getLedger(A), original, '干净退出必须换一本新账本');
  assert.equal(clean.lifetime.getLedger(A).alive(), true, '新账本必须是活的');
  assert.equal(clean.handle.status(A).dispatchAvailable, false, '没有 agent 时不得报可派发');
  const ctxE = createAgent(clean.host, 'agent-E', A);
  assert.equal(clean.handle.status(A).adaptersBlocked, 0, '干净释放不得算作被阻断');
  assert.deepEqual((await armAndRun(clean, A, ctxE, { requestId: 'r-1', callId: 'c-1' })).result, { ok: true },
    '干净释放之后必须真的能派发');
  const cleanState = {
    replacedLedger: clean.lifetime.getLedger(A) !== original,
    ledgerAlive: clean.lifetime.getLedger(A).alive(),
    adaptersBlocked: clean.handle.status(A).adaptersBlocked,
  };
  void ctxA; void ctxD;
  await clean.handle.dispose();

  // The two states must be provably DIFFERENT on every axis that decides behaviour:
  // a faulted ledger is KEPT and dead (replay evidence survives, agents are blocked);
  // a released ledger is REPLACED and alive (resume works). Collapsing them — e.g. by
  // releasing on the fault path or reviving on `agent/created` — reopens the replay
  // window or resurrects the false promise, respectively.
  assert.deepEqual(faultedState, { replacedLedger: true, ledgerAlive: false, adaptersBlocked: 1 });
  assert.deepEqual(cleanState, { replacedLedger: true, ledgerAlive: true, adaptersBlocked: 0 });
  assert.notDeepEqual(faultedState, cleanState, '故障账本与干净释放账本必须是两种可区分状态');
});

// ── R12-4 D (Codex finding 4): linear-scan lifecycle must be tested ──────────────
//
// Codex: "暂不要求用 Set 引入第二份引用状态，线性扫描可用，但要测重复创建/退出、创建失败、
// 最后一个退出和异常清理。"
//
// "最后一个退出" is already covered above ('最后一个 agent 退出后同 session 恢复'); it is
// NOT re-written here. The remaining four edges are.
//
// Why these matter for a linear scan rather than a Set: `adapters` is the ONLY reference
// state. Every one of these paths either skips `adapters.has(entry.id)`, or deletes from
// it twice, or fails to add after having already created the observer — and each mistake
// is invisible unless the double-entry/double-release outcome is asserted directly.

test('D1 重复创建同一 agentId：第二次必须被拒，不得出现两个同 id entry', async () => {
  const w = await world();
  const ctxA = createAgent(w.host, 'agent-A', A);
  // The host can deliver `agent/created` twice for one id (replay, or a re-announce after
  // a failed create). The second one must short-circuit on `adapters.has(agent.id)`.
  const ctxDuplicate = createAgent(w.host, 'agent-A', A);

  assert.equal(w.handle.status(A).agentAdapters, 1, '同 id 不得变成两个 entry');
  assert.equal(w.host.count('session/event'), 2, '重复创建不得再建一个 observer');
  assert.equal(w.host.count('agent/created'), 1, '订阅数量不因重复事件变化');
  assert.equal(ctxDuplicate.listenerNames().length, 0,
    '被拒的第二次创建不得绑定 pre-step：它没有 adapter，也不该有监听');

  // A malformed pre-step delivered to the REJECTED ctx must not fault the ledger, which
  // is only true if no adapter was installed for it.
  ctxDuplicate.fire('agent/pre-step', { turn: 0, step: 1, messages: [] });
  assert.equal(w.lifetime.getLedger(A).alive(), true, '被拒的重复 agent 不得影响共享账本');
  assert.deepEqual((await armAndRun(w, A, ctxA, { requestId: 'r-1', callId: 'c-1' })).result, { ok: true },
    '真正装上的那个 agent 必须继续能派发');
  assert.equal(w.handle.status(A).dispatchAvailable, true);
  assert.equal(w.handle.status(A).adaptersDisconnected, 0, '没有故障，计数必须为 0');
  await w.handle.dispose();
});

test('D2 重复退出同一 agentId：第二次 no-op，不得重复计数或提前 releaseLedger', async () => {
  // (a) The duplicate exit arrives while a SHARED session still has another agent.
  const w = await world();
  const ctxA = createAgent(w.host, 'agent-A', A);
  const ctxB = createAgent(w.host, 'agent-B', A);
  const shared = w.lifetime.getLedger(A);
  assert.deepEqual((await armAndRun(w, A, ctxA, { requestId: 'r-1', callId: 'c-1' })).result, { ok: true });

  w.host.emit('agent/disposed', { agent: { id: 'agent-A', session: { id: A } } });
  w.host.emit('agent/disposed', { agent: { id: 'agent-A', session: { id: A } } });
  assert.equal(w.handle.status(A).agentAdapters, 1, '重复退出不得把幸存者的 entry 一起删掉');
  assert.equal(w.lifetime.getLedger(A), shared,
    '重复退出不得提前 releaseLedger：还有 agent 用着这本账本');
  assert.equal(shared.alive(), true, '重复退出不得断开共享账本');
  assert.equal(w.handle.status(A).adaptersDisconnected, 0, '干净退出不是运行期故障');
  assert.deepEqual((await armAndRun(w, A, ctxB, { requestId: 'r-2', callId: 'c-2' })).result, { ok: true },
    '重复退出之后，剩下的 agent 必须还能派发');
  await w.handle.dispose();

  // (b) The duplicate exit arrives for the LAST agent: the ledger is replaced exactly once.
  const solo = await world();
  const ctxC = createAgent(solo.host, 'agent-C', A);
  assert.deepEqual((await armAndRun(solo, A, ctxC, { requestId: 'r-3', callId: 'c-3' })).result, { ok: true });
  solo.host.emit('agent/disposed', { agent: { id: 'agent-C', session: { id: A } } });
  const afterFirst = solo.lifetime.getLedger(A);
  assert.equal(afterFirst.alive(), true, '干净退出后必须是新的活账本');
  solo.host.emit('agent/disposed', { agent: { id: 'agent-C', session: { id: A } } });
  assert.equal(solo.lifetime.getLedger(A), afterFirst,
    '第二次退出必须是 no-op：不得再 invalidate 一次刚建好的账本');
  assert.equal(afterFirst.alive(), true, '重复退出不得把新账本也断开');
  assert.equal(solo.handle.status(A).dispatchAvailable, false);
  await solo.handle.dispose();
});

test('D3 adapter 构造失败：计数、不入表、不报可派发，且不波及别的 session', async () => {
  const w = await world();
  const ctxOk = createAgent(w.host, 'agent-ok', B);
  assert.deepEqual((await armAndRun(w, B, ctxOk, { requestId: 'r-b1', callId: 'c-b1' })).result, { ok: true });
  const baselineListeners = w.host.count('session/event');
  const baselineAdapters = w.handle.status(B).agentAdapters;
  assert.equal(baselineAdapters, 1, '前提：只有 B 上那一个 agent 装上了 adapter');

  // `broken: true` is a ctx whose `on` returns no disposer: `createQzonePrestepAdapter`
  // validates the returned disposer and throws, which is the construction-failure path.
  createAgent(w.host, 'agent-bad', 'sess-bad', { broken: true });

  const bad = w.handle.status('sess-bad');
  assert.equal(bad.adaptersFailed, 1, '构造失败必须计数（以前是裸 catch 吞掉）');
  assert.equal(w.handle.status().agentAdapters, baselineAdapters,
    '失败的 agent 不得进入 adapters 表（agentAdapters 是全局表大小）');
  assert.equal(bad.dispatchAvailable, false, '没有 adapter 的 session 不得报可派发');
  assert.ok(!bad.dispatchableSessions.includes('sess-bad'));
  assert.equal(w.host.count('session/event'), baselineListeners,
    'adapter 失败后不得留下孤儿 observer：为它新建的 observer 必须回滚');

  // The other session keeps its adapter and still dispatches.
  assert.equal(w.handle.status(B).agentAdapters, baselineAdapters, '别的 session 的 adapter 不得被牵连');
  assert.deepEqual((await armAndRun(w, B, ctxOk, { requestId: 'r-b2', callId: 'c-b2' })).result, { ok: true },
    '构造失败不得打坏死另一个正常 session');

  // A later attempt on the FAILED session is refused rather than papered over: the
  // adapter's constructor disconnects the ledger, so the session is fail-closed and the
  // refusal is counted as `adaptersBlocked` (rebuild required), not as success.
  createAgent(w.host, 'agent-late', 'sess-bad');
  assert.equal(w.handle.status('sess-bad').dispatchAvailable, false, '失败 session 上不得复活出可派发状态');
  assert.equal(w.handle.status('sess-bad').adaptersBlocked, 1, '被拒的后续装配必须可观察');
  assert.equal(w.handle.status().agentAdapters, baselineAdapters, '被拒的 agent 也不得进入 adapters 表');
  await w.handle.dispose();
});

test('D4 异常清理：handle.dispose() 时两个 agent 共享 session，observer 与 ledger 都被清理且不抛', async () => {
  const w = await world();
  createAgent(w.host, 'agent-A', A);
  createAgent(w.host, 'agent-B', A);
  createAgent(w.host, 'agent-C', B);
  const ledgerA = w.lifetime.getLedger(A);
  const ledgerB = w.lifetime.getLedger(B);
  assert.equal(w.host.count('session/event'), 3, '前提：两个 session 各一个 observer + 插件自身订阅');

  // handle.dispose() is the one boundary that must leave the host exactly as it found it,
  // no matter how many agents shared a session or whether they were ever disposed.
  let threw = null;
  try { await w.handle.dispose(); } catch (error) { threw = error?.message ?? String(error); }
  assert.equal(threw, null, 'dispose() 不得抛');

  assert.equal(w.host.count('session/event'), 0, 'observer 必须随 handle 一起销毁，不得留孤儿');
  assert.equal(w.host.count('agent/created'), 0, '插件订阅必须全部解绑');
  assert.equal(w.host.count('agent/disposed'), 0);
  assert.equal(ledgerA.alive(), false, '共享账本必须被断开');
  assert.equal(ledgerB.alive(), false, '另一个 session 的账本也必须被断开');
  assert.equal(w.handle.status().state, 'disposed');
  assert.equal(w.handle.status(A).dispatchAvailable, false);

  // A host event arriving after dispose must be inert, not a throw and not a recording.
  let postThrew = null;
  try {
    w.host.emit('session/event', { id: A }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c-post', name: TOOL } });
  } catch (error) { postThrew = error?.message ?? String(error); }
  assert.equal(postThrew, null, 'dispose 之后到达的 host 事件不得抛');
  assert.equal(ledgerA.peekCall('c-post'), null, 'dispose 之后不得再记录任何绑定');

  // Disposing twice is a no-op, not a second teardown.
  await w.handle.dispose();
  assert.equal(w.host.count('session/event'), 0);
});
