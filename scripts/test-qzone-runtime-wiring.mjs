import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzoneOriginLedger, isOriginLedgerConsumption } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneTrustedBindingGate, isQzoneTrustedBinding } from '../src/core/qzone-trusted-binding.mjs';
import { createQzoneLiveFriendRead } from '../src/core/qzone-live-friend-read.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

// Offline only: every QQ/OneBot effect is a local fake. No network, no real QQ.
const now = Date.parse('2026-11-10T04:00:00Z');
const SESSION = 's1';

function makeStore(overrides = {}) {
  let state = {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, publish: true, comment: true }, reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    notices: [], browseDay: '2026-11-10', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [], ...overrides,
  };
  return {
    read: () => structuredClone(state),
    update(fn) { state = fn(structuredClone(state)); return structuredClone(state); },
  };
}

function fakeCall(calls, msglist) {
  return async (action) => {
    calls.push(action);
    if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
    if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
    if (action === 'get_qzone_msg_list') {
      return { status: 'ok', retcode: 0, data: { total: msglist.length, msglist } };
    }
    throw new Error(`unexpected action ${action}`);
  };
}

function harness({ mode = 'enabled', store = makeStore(), epoch = { v: 8 }, msglist, trackingLimit } = {}) {
  const calls = [];
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: 'rpc-1', origin: 'qq-inbound' });
  const runtime = createQzoneRuntime({
    store, botQq: 123, sourceEpoch: 'e1', authorizeSource: (c) => ledger.ownsConsumption(c), getConnectionEpoch: () => epoch.v, call: fakeCall(calls, msglist ?? [
      { tid: 'post', time: now / 1000 - 5, content: 'recent', cookie: 'never-return' },
    ]),
    getBridgeSessions: (sid) => (sid === SESSION ? ledger : null),
    clock: () => now, mode, ...(trackingLimit === undefined ? {} : { trackingLimit }),
  });
  return { runtime, ledger, store, epoch, calls };
}

function observe(ledger, {
  turn = 1, step = 1, callId = 'c1', messages = [{ role: 'user', source: { rpcId: 'rpc-1' } }],
} = {}) {
  ledger.observeStep({ sessionId: SESSION, turn, step, messages });
  ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn, step, callId } } });
}

const ctx = (callId = 'c1') => ({ sessionId: SESSION, callId });
const readInput = { target_uin: 456 };

test('origin ledger consume 结果可被识别，peekCall 仅返回观察到的 turn/step 且 consume 后失效', () => {
  const { ledger } = harness();
  observe(ledger);
  assert.deepEqual(ledger.peekCall('c1'), { turn: 1, step: 1 });
  const consumption = ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'c1' });
  assert.equal(isOriginLedgerConsumption(consumption), true);
  assert.equal(isOriginLedgerConsumption({ ...consumption }), false);
  assert.equal(ledger.peekCall('c1'), null);
  assert.equal(ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'c1' }), null);
});

test('来源去重达到有界容量时失败关闭，不能通过重放或更改连接代际绕过', async () => {
  const { runtime, ledger, epoch, calls } = harness({ trackingLimit: 1 });
  observe(ledger, { callId: 'first' });
  assert.equal((await runtime.dispatch('read_posts', readInput, ctx('first'))).outcome, 'success');
  ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'second' } } });
  assert.equal((await runtime.dispatch('read_posts', readInput, ctx('second'))).error, 'tracking-capacity');
  const before = calls.length;
  assert.equal((await runtime.dispatch('read_posts', readInput, ctx('first'))).error, 'origin-unverified');
  assert.equal(calls.length, before);
  epoch.v = 9;
  assert.equal((await runtime.dispatch('read_posts', readInput, ctx('second'))).error, 'disconnected');
});

test('连接重建后旧运行时拒绝未消费来源，不得用新代际重新铸票', async () => {
  const { runtime, ledger, epoch, calls } = harness();
  observe(ledger, { callId: 'old-call' });
  epoch.v = 9;
  assert.equal((await runtime.dispatch('read_posts', readInput, ctx('old-call'))).error, 'disconnected');
  assert.deepEqual(calls, []);
});

test('断线时创建的运行时不因后续连接而自动接纳旧来源', async () => {
  const epoch = { v: -1 };
  const { runtime, ledger, calls } = harness({ epoch });
  observe(ledger, { callId: 'old-call' });
  epoch.v = 1;
  assert.equal((await runtime.dispatch('read_posts', readInput, ctx('old-call'))).error, 'disconnected');
  assert.deepEqual(calls, []);
});

test('新来源代际不得接纳旧账本或旧账本的已消费凭证', async () => {
  for (const preconsume of [false, true]) {
    const { ledger, store } = harness();
    observe(ledger, { callId: 'stale' });
    const binding = preconsume ? ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'stale' }) : null;
    const calls = [];
    const runtime = createQzoneRuntime({ store, botQq: 123, getConnectionEpoch: () => 9,
      sourceEpoch: 'new-generation', authorizeSource: (c) => ledger.ownsConsumption(c), getBridgeSessions: () => ledger,
      call: fakeCall(calls, []), clock: () => now, mode: 'read-only' });
    const context = preconsume ? { ...ctx('stale'), binding } : ctx('stale');
    assert.equal((await runtime.dispatch('read_posts', readInput, context)).error, 'origin-unverified');
    assert.deepEqual(calls, []);
  }
});

test('trusted binding 只能由 origin ledger consume 结果铸造，且每次 consume 仅一次', () => {
  const gate = createQzoneTrustedBindingGate();
  const { ledger } = harness();
  observe(ledger);
  const consumption = ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'c1' });

  const forged = gate.mint({
    consumption: { origin: 'qq-inbound', requestId: 'rpc-1', sessionId: SESSION, epoch: 'e1', turn: 1, step: 1, callId: 'c1' },
    connectionEpoch: 8, botQq: 123, targetQq: 456,
  });
  assert.equal(forged, null, '伪造的普通对象不能铸票');

  const binding = gate.mint({ consumption, connectionEpoch: 8, botQq: 123, targetQq: 456 });
  assert.ok(binding, '真实 consume 结果可以铸票');
  assert.equal(gate.verify(binding, { connectionEpoch: 8, botQq: 123 }), true);
  assert.equal(gate.mint({ consumption, connectionEpoch: 8, botQq: 123, targetQq: 456 }), null, '同一 consume 不得二次铸票');
});

test('来源账本断开或回合结束后，已签发但未使用的消费凭据和票据都失效', () => {
  for (const finish of ['disconnect', 'turn-end']) {
    const { ledger } = harness();
    observe(ledger);
    const consumption = ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'c1' });
    const gate = createQzoneTrustedBindingGate();
    const binding = gate.mint({ consumption, connectionEpoch: 8, botQq: 123, targetQq: 456 });
    assert.equal(gate.verify(binding, { connectionEpoch: 8, botQq: 123 }), true);
    if (finish === 'disconnect') ledger.disconnect();
    else ledger.endTurn({ sessionId: SESSION, turn: 1 });
    assert.equal(isOriginLedgerConsumption(consumption), false);
    assert.equal(gate.verify(binding, { connectionEpoch: 8, botQq: 123 }), false);
    assert.equal(isQzoneTrustedBinding(binding), false);
  }
});

test('已消费 callId 后发现重复事件，原消费凭据及已铸票据均被撤销', () => {
  const { ledger } = harness();
  observe(ledger);
  const consumption = ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'c1' });
  const gate = createQzoneTrustedBindingGate();
  const binding = gate.mint({ consumption, connectionEpoch: 8, botQq: 123, targetQq: 456 });
  assert.equal(gate.verify(binding, { connectionEpoch: 8, botQq: 123 }), true);
  assert.equal(ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c1' } } }), false);
  assert.equal(isOriginLedgerConsumption(consumption), false);
  assert.equal(gate.verify(binding, { connectionEpoch: 8, botQq: 123 }), false);
});

test('异步读取期间撤销来源：派发前不访问空间，派发后结果为 unknown', async () => {
  for (const blockedAction of ['get_friend_list', 'get_qzone_msg_list', 'friend_after']) {
    const store = makeStore(), ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
    ledger.registerBridgeRequest({ requestId: 'rpc-1', origin: 'qq-inbound' });
    observe(ledger);
    let enter, release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const barrier = new Promise((resolve) => { release = resolve; });
    const calls = [];
    let friendCalls = 0;
    const runtime = createQzoneRuntime({ store, botQq: 123, sourceEpoch: 'e1', authorizeSource: (c) => ledger.ownsConsumption(c), getConnectionEpoch: () => 8,
      getBridgeSessions: () => ledger, clock: () => now, mode: 'read-only', call: async (action) => {
        calls.push(action);
        if (action === 'get_friend_list') friendCalls++;
        if (action === blockedAction || (blockedAction === 'friend_after' && action === 'get_friend_list' && friendCalls === 2)) {
          enter(); await barrier;
        }
        if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
        if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
        if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
        throw new Error('unexpected');
      } });
    const pending = runtime.dispatch('read_posts', readInput, ctx());
    await entered;
    ledger.disconnect();
    release();
    const result = await pending;
    if (blockedAction === 'get_friend_list') {
      assert.equal(result.error, 'read-denied');
      assert.ok(!calls.includes('get_qzone_msg_list'));
    } else {
      assert.equal(result.outcome, 'unknown');
      assert.equal(calls.filter((x) => x === 'get_qzone_msg_list').length, 1);
    }
  }
});

test('trusted binding 拒绝副本、展开、JSON 往返、纪元或 botQq 不一致', () => {
  const gate = createQzoneTrustedBindingGate();
  const { ledger } = harness();
  observe(ledger);
  const consumption = ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'c1' });
  const binding = gate.mint({ consumption, connectionEpoch: 8, botQq: 123, targetQq: 456 });
  assert.equal(gate.verify({ ...binding }, { connectionEpoch: 8, botQq: 123 }), false);
  assert.equal(gate.verify(JSON.parse(JSON.stringify(binding)), { connectionEpoch: 8, botQq: 123 }), false);
  assert.equal(gate.verify(binding, { connectionEpoch: 9, botQq: 123 }), false, '重连后的新纪元必须拒绝');
  assert.equal(gate.verify(binding, { connectionEpoch: 8, botQq: 999 }), false);
  assert.equal(gate.verify(null, { connectionEpoch: 8, botQq: 123 }), false);
});

test('trusted binding 接受 schedule 形状但拒绝非法 targetQq/epoch', () => {
  // ⚠️ 口径变更（自主机会接线）：gate 现在接受 'schedule' 的**形状**。
  // 它只看形状，看不到 offer —— 「这条 schedule 能不能读空间」由 runtime-wiring 的
  // authorizeBinding 用 `offlineOpportunityOffers` 判定。所以这里断言的是「形状通过了」,
  // 而非法 targetQq/epoch 仍然一律 null（下面那两行原样保留）。
  const gate = createQzoneTrustedBindingGate();
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: 'rpc-s', origin: 'schedule' });
  ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'rpc-s' } }] });
  ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'cs' } } });
  const consumption = ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'cs' });
  const minted = gate.mint({ consumption, connectionEpoch: 8, botQq: 123, targetQq: 456 });
  assert.ok(minted !== null, 'schedule 形状必须能 mint（offer 检查在 authorizeBinding，不在这里）');
  assert.equal(minted.origin, 'schedule');

  const { ledger: qq } = harness();
  observe(qq);
  const qqConsumption = qq.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'c1' });
  assert.equal(gate.mint({ consumption: qqConsumption, connectionEpoch: -1, botQq: 123, targetQq: 456 }), null);
  assert.equal(gate.mint({ consumption: qqConsumption, connectionEpoch: 8, botQq: 123, targetQq: 0 }), null);
});

test('live-friend-read 无 offline 夹具也无生产 authorizeBinding 时仍抛错，不能仅删标记放行', () => {
  const base = { store: makeStore(), clock: () => now, verifyFriendship: async () => null, transport: async () => null,
    verifyRequestProof: async () => null };
  assert.throws(() => createQzoneLiveFriendRead({ ...base }), /offline fixture or production authorizeBinding required/);
  assert.throws(() => createQzoneLiveFriendRead({ ...base, offlineTestFixture: false }), /required/);
  assert.throws(() => createQzoneLiveFriendRead({ store: base.store, clock: base.clock, verifyFriendship: base.verifyFriendship,
    transport: base.transport, authorizeBinding: 'not-a-function' }), /required/);
  assert.throws(() => createQzoneLiveFriendRead({ ...base, authorizeBinding: async () => null }), /isStillAuthorized/);
  assert.doesNotThrow(() => createQzoneLiveFriendRead({ ...base, authorizeBinding: async () => null,
    isStillAuthorized: () => false }));
});

test('composition 成功路径：origin ledger → trusted binding → 生产读路径，并留下审计', async () => {
  const { runtime, ledger, store, calls } = harness();
  observe(ledger);
  const result = await runtime.dispatch('read_posts', readInput, ctx());
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'success');
  assert.deepEqual(result.posts.map((post) => post.id), ['post']);
  assert.equal(JSON.stringify(result).includes('never-return'), false);
  assert.ok(calls.includes('get_qzone_msg_list'));
  const audit = store.read().audit;
  assert.ok(audit.some((entry) => entry.id.startsWith('dsp_') && entry.record.result === 'success'));
  assert.ok(audit.some((entry) => entry.id.startsWith('read_intent_')), '读路径意图须先入账');
  assert.ok(audit.some((entry) => entry.id.startsWith('read:') && entry.record.result === 'success'));
});

test('插件已消费的真实来源凭证可传入 runtime，且不可通过伪造对象冒充', async () => {
  const { runtime, ledger, calls } = harness();
  observe(ledger);
  const binding = ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'c1' });
  const result = await runtime.dispatch('read_posts', readInput, { ...ctx(), binding });
  assert.equal(result.outcome, 'success');
  assert.ok(calls.includes('get_qzone_msg_list'));

  const forged = harness();
  observe(forged.ledger);
  const invalid = await forged.runtime.dispatch('read_posts', readInput, { ...ctx(), binding: { ...binding } });
  assert.equal(invalid.error, 'origin-unverified');
  assert.equal(forged.calls.includes('get_qzone_msg_list'), false);
});

test('composition 拒绝：callId 未被 tool/call 观察、同一 callId 重放、空续步、混合来源、未知 rpcId', async () => {
  const unobserved = harness();
  assert.equal((await unobserved.runtime.dispatch('read_posts', readInput, ctx('missing'))).error, 'origin-unverified');

  const replay = harness();
  observe(replay.ledger);
  assert.equal((await replay.runtime.dispatch('read_posts', readInput, ctx())).ok, true);
  assert.equal((await replay.runtime.dispatch('read_posts', readInput, ctx())).error, 'origin-unverified');

  const empty = harness();
  observe(empty.ledger, { messages: [] });
  assert.equal((await empty.runtime.dispatch('read_posts', readInput, ctx())).error, 'origin-unverified');

  const mixed = harness();
  observe(mixed.ledger, { messages: [{ role: 'user', source: { rpcId: 'rpc-1' } }, { role: 'user', source: { rpcId: 'rpc-x' } }] });
  assert.equal((await mixed.runtime.dispatch('read_posts', readInput, ctx())).error, 'origin-unverified');

  const unknown = harness();
  observe(unknown.ledger, { messages: [{ role: 'user', source: { rpcId: 'rpc-unknown' } }] });
  assert.equal((await unknown.runtime.dispatch('read_posts', readInput, ctx())).error, 'origin-unverified');
});

test('rpcId 只作关联线索：仅有 rpcId 而无 tool/call 观察时不得授权', async () => {
  const { runtime, ledger, calls } = harness();
  ledger.observeStep({ sessionId: SESSION, turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'rpc-1' } }] });
  const result = await runtime.dispatch('read_posts', readInput, ctx('no-call-event'));
  assert.equal(result.error, 'origin-unverified');
  assert.equal(calls.includes('get_qzone_msg_list'), false);
});

test('写路径在任何模式下都不会发出 QQ 调用：comment/reply/like 到 write-not-wired，publish 更早在 origin-unverified 被拒', async () => {
  for (const mode of ['enabled', 'read-only']) {
    const { runtime, ledger, calls } = harness({ mode });
    observe(ledger, { callId: `w-${mode}` });
    // comment carries a single target_uin, so it can mint a binding and reach the write gate.
    const result = await runtime.dispatch('comment', { tid: 't1', target_uin: 456, content: 'hi' }, ctx(`w-${mode}`));
    assert.deepEqual(result, { ok: false, error: 'write-not-wired' }, `mode=${mode}`);
    assert.equal(calls.length, 0, `mode=${mode} 不得发起任何 QQ 调用`);
  }
});

test('publish 在 write-not-wired 之前就被 origin-unverified 拒绝：schema 无单一 target_uin 因而铸不出 binding', async () => {
  for (const mode of ['enabled', 'read-only']) {
    const { runtime, ledger, calls } = harness({ mode });
    observe(ledger, { callId: `p-${mode}` });
    // publish's schema (qzone-mcp-contract.mjs:24-28) is {content, ugc_right, target_uins}:
    // there is no single target_uin, so normalizeTarget -> null and gate.mint -> null,
    // which is refused by the `if (!binding) return denied('origin-unverified', 'policy')`
    // check right after gate.mint — one step EARLIER than the write gate. Stricter,
    // not looser, but it must not be described as "every write path returns
    // write-not-wired".
    const result = await runtime.dispatch('publish', { content: 'hi', ugc_right: 1 }, ctx(`p-${mode}`));
    assert.deepEqual(result, { ok: false, error: 'origin-unverified' }, `mode=${mode}`);
    assert.equal(calls.length, 0, `mode=${mode} 不得发起任何 QQ 调用`);
  }
});

test('publish 带 target_uins 时同样铸不出 binding：不得退化成 target_uins[0] 而走到写闸', async () => {
  // The realistic publish shape for ugc_right in {16,128} always carries
  // target_uins (qzone-mcp-contract.mjs:37-43). If normalizeTarget ever grew a
  // `target_uins[0]` fallback, publish would mint a binding and be refused at the
  // write gate with 'write-not-wired' instead — same "no QQ call" outcome but a
  // different, weaker reason, and the contract would have silently changed. Pin
  // the exact error so that fallback cannot land unnoticed.
  for (const mode of ['enabled', 'read-only']) {
    const { runtime, ledger, calls } = harness({ mode });
    observe(ledger, { callId: `pu-${mode}` });
    const result = await runtime.dispatch('publish', { content: 'hi', ugc_right: 16, target_uins: [456] }, ctx(`pu-${mode}`));
    assert.deepEqual(result, { ok: false, error: 'origin-unverified' }, `mode=${mode}`);
    assert.equal(calls.length, 0, `mode=${mode} 不得发起任何 QQ 调用`);
  }
});

test('总开关、mode=disabled、断连、非法 ctx 均 fail closed', async () => {
  const off = harness({ store: makeStore({ enabled: false }) });
  observe(off.ledger);
  assert.equal((await off.runtime.dispatch('read_posts', readInput, ctx())).error, 'tool-denied');

  const disabled = harness({ mode: 'disabled' });
  observe(disabled.ledger);
  assert.equal((await disabled.runtime.dispatch('read_posts', readInput, ctx())).error, 'disabled');

  const disconnected = harness();
  observe(disconnected.ledger);
  disconnected.epoch.v = -1;
  assert.equal((await disconnected.runtime.dispatch('read_posts', readInput, ctx())).error, 'disconnected');

  const extra = harness();
  observe(extra.ledger);
  assert.equal((await extra.runtime.dispatch('read_posts', readInput, { sessionId: SESSION, callId: 'c1', turn: 1 })).error,
    'missing-native-context');
});

test('同一 callId 并发两次 dispatch 只能成功一次', async () => {
  const { runtime, ledger } = harness();
  observe(ledger);
  const [a, b] = await Promise.all([
    runtime.dispatch('read_posts', readInput, ctx()),
    runtime.dispatch('read_posts', readInput, ctx()),
  ]);
  const successes = [a, b].filter((r) => r.ok === true).length;
  assert.equal(successes, 1);
});

test('未知读结果后相同 callId 不重放，新的已认证工具调用可重新读取', async () => {
  const store = makeStore();
  const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: 'rpc-1', origin: 'qq-inbound' });
  let reads = 0;
  const runtime = createQzoneRuntime({ store, botQq: 123, sourceEpoch: 'e1', authorizeSource: (c) => ledger.ownsConsumption(c), getConnectionEpoch: () => 8,
    getBridgeSessions: () => ledger, clock: () => now, mode: 'read-only',
    call: async (action) => {
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123 } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
      if (action === 'get_qzone_msg_list') {
        if (++reads === 1) throw new Error('unknown result');
        return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
      }
      throw new Error('unexpected');
    } });
  observe(ledger, { callId: 'read-first' });
  assert.equal((await runtime.dispatch('read_posts', readInput, ctx('read-first'))).outcome, 'unknown');
  assert.equal((await runtime.dispatch('read_posts', readInput, ctx('read-first'))).error, 'origin-unverified');
  ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'read-again' } } });
  assert.equal((await runtime.dispatch('read_posts', readInput, ctx('read-again'))).outcome, 'success');
  assert.equal(reads, 2);
});

test('status 报告模式、连接状态与已接线工具', () => {
  const { runtime, epoch } = harness();
  // t43: `read_comments` is wired for plain comment pages regardless of `exceptionReads`,
  // so it is reported as wired. (It used to be listed only when the host supplied
  // `fetchCommentPage`, which no host injects.)
  assert.deepEqual(runtime.status(), { mode: 'enabled', connected: true, wiredTools: ['read_posts', 'read_comments'] });
  epoch.v = -1;
  assert.equal(runtime.status().connected, false);
});
