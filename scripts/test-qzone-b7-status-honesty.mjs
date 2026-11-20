// Pins the B7 minimal fix (Codex ruling §1): `status()` must derive dispatchability from
// the ledger and observer the plugin ALREADY holds, read-only, instead of trusting an
// adapter entry that nobody invalidated.
//
// The defect: `sourceLifetime.invalidate(S)` (what `coordinator.invalidate` forwards to)
// disconnects the cached ledger but does NOT change the epoch and does NOT notify the
// plugin. Nothing on the status path noticed, so the session stayed in
// `dispatchableSessions` while `registerBridgeRequest` threw 「来源账本不可用或已满」 and
// every dispatch failed `origin-unbound` — a false promise of exactly the kind
// `dispatchAvailable` exists to prevent. Case B7-1 is the healthy CONTROL: it proves the
// fix is not "just answer false to everything".
//
// What this file pins, and what it deliberately does NOT:
//   · pinned: status TRUTHFULNESS — `dispatchAvailable`/`dispatchableSessions` stop
//     advertising a session whose cached ledger or observer is not alive.
//   · NOT pinned: that a `true` answer guarantees a successful dispatch. A call can still
//     fail for reasons outside this field (no bridge request registered for that step, a
//     callId that was never announced, capacity). Codex corrected the earlier, stronger
//     reading; the control case checks ONE real end-to-end dispatch, not a promise over
//     every possible call.
//   · NOT pinned: production readiness. Nothing here is wired in production.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';
import { createQzoneSessionObserver } from '../plugins/qzone-safe/session-observer.mjs';
import { createQzoneSourceLifetime } from '../src/core/qzone-source-lifetime-offline.mjs';

const TOOL = 'qzone_read_posts';
const defineTool = (tool) => tool;
const execFor = (sessionId, callId) => ({ agent: { session: { id: sessionId } }, callId });
const userMessage = (requestId) => ({ role: 'user', source: { rpcId: requestId } });

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
    emit(name, ...args) { for (const fn of listeners.get(name) ?? []) fn(...args); },
  };
}

function agentCtx() {
  const callbacks = new Map();
  return {
    on(name, fn) { const list = callbacks.get(name) ?? []; list.push(fn); callbacks.set(name, list); return () => {}; },
    fire(name, payload) { for (const fn of callbacks.get(name) ?? []) fn(payload, () => {}); },
  };
}

// The lifetime is wrapped so that a status() path reaching for `getLedger` (i.e. MINTING a
// ledger from a getter) is visible as a call-count change. Reading the plugin's own cache
// must not touch this counter at all.
function countingLifetime(options) {
  const inner = createQzoneSourceLifetime(options);
  const counts = { getLedger: 0, invalidate: 0, sourceEpoch: 0 };
  const wrapper = {
    sourceEpoch() { counts.sourceEpoch += 1; return inner.sourceEpoch(); },
    getLedger(sessionId) { counts.getLedger += 1; return inner.getLedger(sessionId); },
    invalidate(sessionId) { counts.invalidate += 1; return inner.invalidate(sessionId); },
    rotate: () => inner.rotate(),
    close: () => inner.close(),
    ownsConsumption: (value) => inner.ownsConsumption(value),
  };
  return { inner, wrapper, counts };
}

async function world({ sessionLimit = 8, trackingLimit = 64 } = {}) {
  const host = fakeHost();
  const { inner, wrapper, counts } = countingLifetime({ sessionLimit, trackingLimit });
  const dispatches = [];
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: inner.sourceEpoch(),
    defineTool,
    sourceLifetime: wrapper,
    dispatch: async (action, input, context) => { dispatches.push({ action, context }); return { ok: true }; },
  });
  return { host, lifetime: inner, counts, handle, dispatches };
}

function createAgent(host, agentId, sessionId) {
  const ctxOf = agentCtx();
  host.emit('agent/created', { agent: { id: agentId, session: { id: sessionId }, ctx: ctxOf } });
  return ctxOf;
}

const COUNTERS = ['adaptersDisconnected', 'adaptersBlocked', 'stepsRefused', 'positionsEvictedLive', 'adaptersFailed'];
const countersOf = (status) => Object.fromEntries(COUNTERS.map((key) => [key, status[key]]));

let turnCounter = 0;
// One complete dispatchable turn in real DSH order: the tool runs INSIDE the turn and
// `turn/end` closes it afterwards (`endTurn` reaps that turn's `calls`, so emitting it
// first would make every dispatch fail `origin-unbound` — see test-qzone-agent-resume).
async function armAndRun(w, sessionId, ctxOf, { requestId, callId }) {
  turnCounter += 1;
  const turn = turnCounter;
  w.handle.registerBridgeRequest(sessionId, { requestId, origin: 'qq-inbound' });
  ctxOf.fire('agent/pre-step', { turn, step: 1, messages: [userMessage(requestId)] });
  w.host.emit('session/event', { id: sessionId }, { type: 'tool/call', data: { turn, step: 1, callId, name: TOOL } });
  const result = await w.host.registered.get(TOOL).execute({ target_uin: 456 }, execFor(sessionId, callId));
  w.host.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn } });
  return result;
}

// ── 1. healthy control ────────────────────────────────────────────────────────────────
test('B7-1 健康对照：正常接线时 status 为真、会话在列表里，且真能派发一次 {ok:true}', async () => {
  const w = await world();
  const ctxOf = createAgent(w.host, 'a1', 's-healthy');

  const status = w.handle.status('s-healthy');
  assert.equal(status.dispatchAvailable, true, '正常接线必须报可派发（否则整组用例会靠「一律 false」假绿）');
  assert.deepEqual(status.dispatchableSessions, ['s-healthy']);

  assert.deepEqual(await armAndRun(w, 's-healthy', ctxOf, { requestId: 'r-1', callId: 'c-1' }), { ok: true },
    'status 说能派，真实的 tool.execute 就必须成功');
  assert.equal(w.dispatches.length, 1, '而且必须真的走到注入的 dispatch');
  await w.handle.dispose();
});

// ── 2. after invalidate ──────────────────────────────────────────────────────────────
test('B7-2 直接 invalidate 后：status 转假、列表不含它，且旧账本确实不可用（不是只翻布尔位）', async () => {
  const w = await world();
  createAgent(w.host, 'a1', 's-inv');
  assert.equal(w.handle.status('s-inv').dispatchAvailable, true, '前提：invalidate 之前是可派发的');

  assert.equal(w.lifetime.invalidate('s-inv'), true, '前提：invalidate 确实丢弃了一本账本');

  const status = w.handle.status('s-inv');
  assert.equal(status.dispatchAvailable, false, 'invalidate 之后不得再报可派发');
  assert.deepEqual(status.dispatchableSessions, [], '列表必须同源转空');

  // The state must match reality, not just the flag: the ledger the plugin still holds is
  // the one invalidate() disconnected, so registering a new bridge request on it throws.
  assert.throws(() => w.handle.registerBridgeRequest('s-inv', { requestId: 'r-old', origin: 'qq-inbound' }),
    /来源账本不可用或已满/,
    '旧账本必须真的不可用；如果这里还能登记，说明 status 的 false 与真实不一致');

  // The adapter is still there — the session was never "disposed", it simply can no longer
  // dispatch. That is exactly the shape that used to be mis-advertised.
  assert.equal(status.agentAdapters, 1);
  assert.equal(status.adaptersDisconnected, 0, 'invalidate 不经过插件的故障通道，不得凭空计一次断流');
  await w.handle.dispose();
});

// ── 3. other sessions unaffected ──────────────────────────────────────────────────────
test('B7-3 其他 session 不受影响：invalidate 其中一个，另一个仍可派发且真能派发', async () => {
  const w = await world();
  createAgent(w.host, 'a1', 's-a');
  const ctxB = createAgent(w.host, 'a2', 's-b');
  assert.equal(w.handle.status('s-a').dispatchAvailable, true);
  assert.equal(w.handle.status('s-b').dispatchAvailable, true);

  w.lifetime.invalidate('s-a');

  assert.equal(w.handle.status('s-a').dispatchAvailable, false, '被 invalidate 的那个必须转假');
  const statusB = w.handle.status('s-b');
  assert.equal(statusB.dispatchAvailable, true, '另一个 session 必须继续为真（否则就是「一刀切」）');
  assert.deepEqual(statusB.dispatchableSessions, ['s-b'], '列表里只能剩下真正可用的那个');

  assert.deepEqual(await armAndRun(w, 's-b', ctxB, { requestId: 'r-b1', callId: 'c-b1' }), { ok: true },
    '另一个 session 必须真的还能派发，不只是布尔位');
  assert.equal(w.handle.status('s-b').dispatchAvailable, true, '派发之后另一个 session 仍然正常');

  // s-a's adapter is untouched; only its ledger is dead.
  assert.equal(w.handle.status('s-a').agentAdapters, 2, 's-a 的 adapter 仍在表里（未被 dispose）');
  await w.handle.dispose();
});

// ── 4. status is read-only ────────────────────────────────────────────────────────────
test('B7-4 读状态无副作用：N 次 status() 不新建账本、不动缓存、不改任何计数', async () => {
  const w = await world();
  const ctxOf = createAgent(w.host, 'a1', 's-ro');
  createAgent(w.host, 'a2', 's-ro2');

  const before = {
    getLedger: w.counts.getLedger,
    invalidate: w.counts.invalidate,
    counters: countersOf(w.handle.status('s-ro')),
  };

  const shapes = new Set();
  for (let i = 0; i < 25; i += 1) {
    const a = w.handle.status('s-ro');
    const b = w.handle.status();
    const c = w.handle.status(null);
    shapes.add(`${a.dispatchAvailable}/${b.dispatchAvailable}/${c.dispatchAvailable}`);
    assert.deepEqual([...a.dispatchableSessions].sort(), ['s-ro', 's-ro2']);
  }

  // A session id the plugin has never seen must also stay free of side effects: no ledger
  // minted, no adapter invented, and the answer is a plain false.
  for (let i = 0; i < 5; i += 1) {
    const unknown = w.handle.status('s-never-seen');
    assert.equal(unknown.dispatchAvailable, false, '没见过的会话不得报可派发');
    assert.deepEqual(unknown.dispatchableSessions, ['s-ro', 's-ro2'], '列表仍只反映真实接线的会话');
    assert.equal(unknown.agentAdapters, 2, '读状态不得凭空造出 adapter');
  }

  assert.equal(w.counts.getLedger, before.getLedger,
    'status() 不得调用 getLedger —— 那会为未缓存的会话铸一本新账本（getter 里做写操作）');
  assert.equal(w.counts.invalidate, before.invalidate, 'status() 不得调用 invalidate');
  assert.equal(shapes.size, 1, '重复读必须给出稳定答案（同一 tick 内不会自相矛盾）');
  assert.deepEqual(countersOf(w.handle.status('s-ro')), before.counters,
    '读状态不得递增任何故障/拒绝计数');

  // The session must still really work afterwards: a read-only probe that quietly purged
  // or replaced the ledger would show up as a failed dispatch here.
  assert.deepEqual(await armAndRun(w, 's-ro', ctxOf, { requestId: 'r-ro', callId: 'c-ro' }), { ok: true },
    '读了 25 次状态之后，派发必须仍然成功');
  await w.handle.dispose();
});

// ── 5. observer liveness ──────────────────────────────────────────────────────────────
test('B7-5a observer.alive() 必须把「已 dispose」算作不存活，而 disconnected() 仍只表达故障', () => {
  const listeners = new Map();
  const ctx = { on(name, fn) { const l = listeners.get(name) ?? []; l.push(fn); listeners.set(name, l); return () => {}; } };
  const stubLedger = () => ({
    observeStep: () => true, observeToolCall: () => true, endTurn: () => true, disconnect: () => {},
  });
  const observer = createQzoneSessionObserver({ eventContext: ctx, ledger: stubLedger(), sessionId: 's-obs' });

  assert.equal(observer.alive(), true, '刚建好必须存活');
  assert.equal(observer.disconnected(), false);

  observer.dispose();
  assert.equal(observer.alive(), false,
    'dispose 之后不得再报存活：dispose 只清 active，旧实现 alive = !disconnected 会在这里说 true');
  assert.equal(observer.disconnected(), false,
    'disconnected() 是故障闩锁，不是生命周期位；干净销毁绝不能把自己伪装成一次断流');
  assert.equal(observer.disposed(), true, 'disposed() 才是销毁位的读数');

  // The fault latch still behaves exactly as before.
  const faulty = createQzoneSessionObserver({ eventContext: ctx, ledger: stubLedger(), sessionId: 's-obs2' });
  faulty.disconnect();
  assert.equal(faulty.alive(), false);
  assert.equal(faulty.disconnected(), true, '故障必须仍然由 disconnected() 表达');
  assert.equal(faulty.disposed(), false, '故障不是销毁，disposed() 必须仍说 false');
});

test('B7-5b 最后一个 agent 干净退出后，该会话必须从可派发集合里消失（observer 已销毁）', async () => {
  // This case pins the OBSERVABLE half: the last agent on a session leaves cleanly, the
  // plugin disposes that session's observer and drops the cached ledger, so the session
  // must disappear from the advertised set while the handle and the other session stay
  // healthy.
  //
  // HONEST LIMIT, measured not assumed: this shape alone does not isolate the observer
  // probe. Deleting only the `strictObserverIsAlive` line (mutation M2 in the report) leaves
  // all eight cases green, because every path that disposes an observer TODAY also removes
  // the adapter entry and/or drops the cached ledger — those two checks already exclude the
  // session. The observer probe is therefore defense-in-depth for a future refactor, not a
  // load-bearing branch, and no black-box test can pin it without a seam. It is kept because
  // Codex asked for state to be derived from BOTH held objects, and because the day someone
  // disposes an observer without one of the other two, this check is what stops the false
  // promise. `B7-5a` pins the `alive()` semantics that probe relies on.
  const w = await world();
  createAgent(w.host, 'a1', 's-gone');
  createAgent(w.host, 'a2', 's-alive');
  assert.equal(w.handle.status('s-gone').dispatchAvailable, true, '前提：离开之前是可派发的');

  w.host.emit('agent/disposed', { agent: { id: 'a1', session: { id: 's-gone' } } });

  const status = w.handle.status('s-gone');
  assert.equal(status.dispatchAvailable, false, 'observer 已销毁 + 账本已释放，不得再报可派发');
  assert.deepEqual(status.dispatchableSessions, ['s-alive'], '列表里只能留下真正还活着的会话');
  assert.equal(status.agentAdapters, 1, 'adapter 已随 agent/disposed 移除，剩下的是另一个会话的');
  await w.handle.dispose();
});

// ── 6. production dependency contract: a ledger without alive() is NOT dispatchable ───
test('B7-6 生产依赖契约：注入的账本缺 alive() 时必须判为不可派发（status 走严格版，构造路径仍宽松）', async () => {
  // Production contract, stated in `index.mjs`: whatever is injected as a ledger MUST
  // implement `alive(): boolean`. A ledger that cannot answer that question cannot support
  // an availability promise, so `status()` fails closed on it — while the CONSTRUCTION path
  // stays lenient (an older injected ledger still gets wired instead of turning a
  // compatibility gap into an outage). This case pins both halves at once: the agent is
  // wired (adapter exists) yet the session is NOT advertised.
  const host = fakeHost();
  const legacyLedger = {
    observeStep: () => true,
    observeToolCall: () => true,
    endTurn: () => true,
    disconnect: () => {},
    registerBridgeRequest: () => {},
    // deliberately no `alive`
  };
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'e1',
    defineTool,
    // A lifetime stub that hands out a ledger WITHOUT `alive()`, i.e. the legacy injection
    // the lenient construction check tolerates.
    sourceLifetime: { sourceEpoch: () => 'e1', getLedger: () => legacyLedger, invalidate: () => true },
    dispatch: async () => ({ ok: true }),
  });
  createAgent(host, 'a1', 's-legacy');

  const status = handle.status('s-legacy');
  assert.equal(status.agentAdapters, 1, '构造路径仍是宽松版：没有 alive() 也要把 agent 接上');
  assert.equal(status.adaptersBlocked, 0, '不得把兼容缺口算成一次拒绝');
  assert.equal(status.dispatchAvailable, false,
    '但签发可用承诺时必须严格：账本答不出 alive() ⇒ 不可派发（fail-closed）');
  assert.deepEqual(status.dispatchableSessions, [], '列表必须与布尔位同源');

  await handle.dispose();

  // POSITIVE CONTROL on a separate handle: the only difference is that this ledger CAN
  // answer `alive()`. If the false above came from a blanket refusal rather than from the
  // strict probe, this handle would be false too.
  const host2 = fakeHost();
  const capableLedger = { ...legacyLedger, alive: () => true };
  const handle2 = await createQzonePluginHandle(host2.ctx, { enabled: true }, {
    epoch: 'e1',
    defineTool,
    sourceLifetime: { sourceEpoch: () => 'e1', getLedger: () => capableLedger, invalidate: () => true },
    dispatch: async () => ({ ok: true }),
  });
  createAgent(host2, 'a1', 's-legacy');
  const capable = handle2.status('s-legacy');
  assert.equal(capable.dispatchAvailable, true,
    '同一形状只把 alive() 补上就必须转为可派发：证明上一条的 false 来自严格判据，不是一刀切');
  assert.deepEqual(capable.dispatchableSessions, ['s-legacy']);
  await handle2.dispose();
});

// ── 7a. R-1: a HEALTHY clean exit may rebuild under the same generation ───────────────
//
// Recovery semantics are split in `PRODUCTION-WIRING-REQUIREMENTS.md` §1-B7-b and this is
// the R-1 case: NO external revocation happened, every agent left cleanly, so a legitimate
// rebuild under the same connection generation must mint a fresh ledger and dispatch —
// without a global re-verify.
test('B7-7a R-1 健康正常退出：同代际重建后必须可派发且新请求成功（不强制全局 verify）', async () => {
  const w = await world();
  const ctxOld = createAgent(w.host, 'a-old', 's-r1');
  assert.deepEqual(await armAndRun(w, 's-r1', ctxOld, { requestId: 'r-1', callId: 'c-1' }), { ok: true },
    '前提：退出之前这条链路是通的');

  const epochBefore = w.lifetime.sourceEpoch();
  w.host.emit('agent/disposed', { agent: { id: 'a-old', session: { id: 's-r1' } } });
  assert.equal(w.lifetime.sourceEpoch(), epochBefore, 'R-1 重建不得要求换代：仍是同一连接代际');

  const ctxNew = createAgent(w.host, 'a-new', 's-r1');
  const rebuilt = w.handle.status('s-r1');
  assert.equal(rebuilt.dispatchAvailable, true, 'R-1：合法重建之后必须重新可派发');
  assert.deepEqual(rebuilt.dispatchableSessions, ['s-r1']);
  assert.equal(rebuilt.adaptersBlocked, 0, 'R-1 是健康路径，不得被当成撤销而计入 adaptersBlocked');
  assert.deepEqual(await armAndRun(w, 's-r1', ctxNew, { requestId: 'r-new-1', callId: 'c-new-1' }), { ok: true },
    'R-1：新请求必须真的成功（否则这个修复就是「全部拒绝」式的假绿）');
  await w.handle.dispose();
});

// ── 7b. R-2: an EXTERNAL revocation must NOT be healed by exit / rebuild / status ─────
//
// The distinction that makes this testable: `lifetime.invalidate(S)` disconnects the SAME
// frozen ledger the plugin has cached, WITHOUT touching the generation and WITHOUT setting
// `entry.dead` (nothing inside the plugin faulted). A healthy clean exit never sees a dead
// cached ledger, so the guard fires exactly for the external case.
//
// Replay uses the REAL consumed pair (`r-old-1` / `c-old-1`) on purpose: a never-registered
// id would only prove "a dead ledger refuses new registration", which is a different claim.
test('B7-7b R-2 外部撤销：退出 + 重建 + 查 status 都不得自动恢复，真重放仍被拒', async () => {
  const w = await world();
  const ctxOld = createAgent(w.host, 'a-old', 's-r2');
  assert.deepEqual(await armAndRun(w, 's-r2', ctxOld, { requestId: 'r-old-1', callId: 'c-old-1' }), { ok: true },
    '前提：撤销之前这条链路是通的，且 (r-old-1, c-old-1) 已被真实消费');

  const epochBefore = w.lifetime.sourceEpoch();
  w.lifetime.invalidate('s-r2');
  assert.equal(w.handle.status('s-r2').dispatchAvailable, false, '外部撤销后必须立刻转假');

  // 「撤销事实不能依赖是否调用过 status」—— 这里刻意多次读 status，且断言它不改变结局。
  for (let i = 0; i < 3; i += 1) assert.equal(w.handle.status('s-r2').dispatchAvailable, false);

  // 真重放：用已消费的那一组 id，而不是一个从未登记的新 id。
  assert.throws(() => w.handle.registerBridgeRequest('s-r2', { requestId: 'r-old-1', origin: 'qq-inbound' }),
    /来源账本不可用或已满/, '失效账本连已消费过的 requestId 也不得放行');

  w.host.emit('agent/disposed', { agent: { id: 'a-old', session: { id: 's-r2' } } });
  assert.equal(w.lifetime.sourceEpoch(), epochBefore, '外部撤销不该换代，撤销事实与代际无关');

  const ctxNew = createAgent(w.host, 'a-new', 's-r2');
  const rebuilt = w.handle.status('s-r2');
  assert.equal(rebuilt.dispatchAvailable, false, 'R-2：clean 退出 + 重建之后仍不得可派发');
  assert.deepEqual(rebuilt.dispatchableSessions, []);
  assert.equal(rebuilt.adaptersBlocked, 1, '被撤销的账本必须让重建被拒且可观察');

  // 再读一次 status，确认「读了也不会变好」。
  assert.equal(w.handle.status('s-r2').dispatchAvailable, false, 'R-2：查询 status 不得恢复授权');

  // `armAndRun` registers first, so a blocked session throws there — that IS the refusal.
  // Accepted either way (throw OR a non-ok result), but never `{ ok: true }`.
  let replayOutcome;
  try {
    replayOutcome = await armAndRun(w, 's-r2', ctxNew, { requestId: 'r-old-1', callId: 'c-old-1' });
  } catch (error) {
    replayOutcome = { threw: String(error?.message ?? error) };
  }
  assert.notDeepEqual(replayOutcome, { ok: true }, 'R-2：重建之后重放同一组已消费 id 仍必须失败');
  assert.ok(replayOutcome.threw !== undefined || replayOutcome.ok === false,
    `R-2：重放必须被明确拒绝，实际 ${JSON.stringify(replayOutcome)}`);
  await w.handle.dispose();
});

// ── 8. faulted sessions stay dead ─────────────────────────────────────────────────────
test('B7-8 故障会话不得靠「退出 + 重建」复活（只有 clean 边界能重建，故障边界不能）', async () => {
  const w = await world();
  const ctxFault = createAgent(w.host, 'a-fault', 's-fault');
  // A malformed pre-step latches `continuityLost` on the shared ledger and faults the entry.
  ctxFault.fire('agent/pre-step', { turn: 0, step: 1, messages: [] });
  assert.equal(w.lifetime.getLedger('s-fault').alive(), false, '前提：账本确实被打死');
  assert.equal(w.handle.status('s-fault').dispatchAvailable, false);

  w.host.emit('agent/disposed', { agent: { id: 'a-fault', session: { id: 's-fault' } } });

  // The dead ledger must still be the cached one (replay protection survives the fault), so
  // a rebuild is REFUSED rather than silently re-armed.
  const dead = w.lifetime.getLedger('s-fault');
  assert.equal(dead.alive(), false, '故障账本必须留在缓存里，不得换新');
  createAgent(w.host, 'a-after', 's-fault');
  const status = w.handle.status('s-fault');
  assert.equal(status.dispatchAvailable, false, '故障会话上新建 agent 也不得报可派发');
  assert.equal(status.adaptersBlocked, 1, '被拒的重建必须可观察');
  assert.deepEqual(status.dispatchableSessions, []);
  await w.handle.dispose();
});
