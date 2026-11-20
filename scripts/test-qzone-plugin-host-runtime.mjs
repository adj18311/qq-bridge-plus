// The plugin-side host runtime: does it really turn injected dependencies into a source the
// qzone-safe plugin can dispatch over, and does it stay FAIL-CLOSED on writes by default?
//
// WHAT IS REAL HERE
//   · a real temporary SQLite store (openOfflineStore) under the OS temp dir, with a real
//     initialized B2 replay collection (initializeReplayState) where a test needs writes;
//   · the REAL module under test (createQzonePluginHostRuntime);
//   · the REAL origin ledger it creates, the REAL runtime it composes (createQzoneRuntime), the
//     REAL operation authorizer, the REAL offline write path and the REAL approved-write
//     composition;
//   · the REAL plugin (plugins/qzone-safe/index.mjs) in the last test: the handle is built from
//     OUR object, which is what "the plugin can actually use it" means.
//
// WHAT IS A FIXTURE, AND ONLY THIS
//   · call  — the read transport never leaves the process; it only counts (and is asserted to be
//     untouched in every write test);
//   · send  — the OneBot call is never made; it records the payload and answers {ok:true};
//   · approveOperation — the host verdict (there is no human and no console here);
//   · clock — pinned, so the quota day and the cooldowns are deterministic.
//
// WHAT THIS FILE DOES NOT PROVE: that a real approval came from a human across processes, that a
// real OneBot request was issued, or that a real QQ account/session exists. call and send are
// injected everywhere and counted, never performed. The trust assertions below are about the
// SOURCE (a consumption must be branded by a ledger this module already owns), not the platform.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { createQzonePluginHostRuntime } from '../src/core/qzone-plugin-host-runtime.mjs';
import { createQzonePluginHandle, STATES } from '../plugins/qzone-safe/index.mjs';

const NOW = Date.parse('2026-11-15T04:00:00Z');
const ACCOUNT = 123;
const SESSION = 's1';
const EPOCH = 'e1';
const COMMENT_INPUT = Object.freeze({ tid: 'post-1', target_uin: 456, content: 'nice post' });
const PUBLISH_INPUT = Object.freeze({ content: 'hello world', ugc_right: 1 });

/** Every field the real store needs for the policy gate, the quota ledger and the audit sink. */
function initialState(now = NOW) {
  return {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 10, comment: 25, like: 30 },
    ledger: { day: beijingDay(now), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
    reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    browseDay: beijingDay(now), todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [], notices: [],
  };
}

/** One world: a real temp SQLite store, counting transports, and a builder for the module. */
function world(t, { replay = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-plugin-host-'));
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle */ }
    }
  });
  const store = openOfflineStore(path.join(dir, 'state.db'), initialState());
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  if (replay) {
    assert.equal(initializeReplayState(store, { now: NOW }).ok, true, '前提：B2 replay 集合已初始化');
  }

  const calls = [];
  const sent = [];
  const approvals = [];
  const call = async (action) => { calls.push(action); return { status: 'ok', retcode: 0, data: {} }; };
  const send = async (payload) => { sent.push(payload); return { ok: true }; };
  // MUTABLE clock: the comment interval is 3 minutes and the publish interval 2 hours, both
  // real rules of the write path. A test that needs two writes in a row advances `live.now`
  // instead of weakening the rule.
  const live = { now: NOW };
  const writePath = (transport) => createOfflineWritePath({ store, clock: () => live.now, transport });
  let step = 0;
  /** Ledgers whose fixture turn has been armed (one pre-step per ledger, see `position`). */
  const armed = new WeakSet();

  const base = {
    store, botQq: ACCOUNT, sourceEpoch: EPOCH, clock: () => live.now, call,
    getConnectionEpoch: () => 8,
    approveOperation: (operation) => { approvals.push(operation); return true; },
    replayStore: store,
  };

  return {
    dir, store, live, calls, sent, approvals, call, send, writePath,
    /** Build the module under test, with the fixture defaults overridable. */
    build(over = {}) {
      const options = { ...base, ...over };
      for (const key of Object.keys(options)) {
        if (options[key] === undefined) delete options[key];
      }
      return createQzonePluginHostRuntime(options);
    },
    /** The complete write wiring, with the fixture's recording send. */
    wiring(over = {}) {
      return { send, writePath, source: 'qq', actions: ['publish', 'comment', 'reply', 'like'], ...over };
    },
    /**
     * Install one genuine ledger position and return the ids a dispatch must present.
     *
     * THE SHAPE MATCHES THE LEDGER'S OWN RULES, and they are not negotiable here:
     *   · a bridge requestId may be cited by only ONE step — a turn that cites a second id is
     *     TAINTED and every consume in it returns null
     *     (qzone-origin-ledger-offline.mjs:212-232); so the whole fixture turn uses ONE id;
     *   · several tool calls may share one (turn, step) — the ledger binds one callId per
     *     `observeToolCall`, and each is a separate consumable position
     *     (measured: three callIds on one step, three branded consumptions).
     * So the first call arms turn 1 / step 1, and every later call adds a NEW callId to it.
     */
    position(ledger) {
      step += 1;
      const callId = 'c-' + step;
      if (!armed.has(ledger)) {
        ledger.registerBridgeRequest({ requestId: 'r-1', origin: 'qq-inbound' });
        assert.equal(ledger.observeStep({
          sessionId: SESSION, turn: 1, step: 1,
          messages: [{ role: 'user', source: { rpcId: 'r-1' } }],
        }), true, '前提：turn 1 / step 1 已观察');
        armed.add(ledger);
      }
      assert.equal(ledger.observeToolCall({
        sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId } },
      }), true, '前提：tool/call ' + callId + ' 已记录');
      return { sessionId: SESSION, callId };
    },
  };
}

// ============================================================================================
// 1. MISSING DEPENDENCIES — TypeError, never a silently invented default
// ============================================================================================
test('PH-1 缺任一必填依赖 ⇒ TypeError（逐项），未知键/访问器/类型错误同样拒绝', (t) => {
  const w = world(t);
  const good = {
    store: w.store, botQq: ACCOUNT, sourceEpoch: EPOCH, clock: () => NOW, call: w.call,
    getConnectionEpoch: () => 8, approveOperation: () => true, replayStore: w.store,
  };
  const without = (key) => { const copy = { ...good }; delete copy[key]; return copy; };

  assert.throws(() => createQzonePluginHostRuntime(undefined), TypeError, '未传 options');
  assert.throws(() => createQzonePluginHostRuntime(null), TypeError, 'null options');
  assert.throws(() => createQzonePluginHostRuntime([]), TypeError, '数组 options');

  for (const key of ['store', 'botQq', 'sourceEpoch', 'clock', 'call',
    'getConnectionEpoch', 'approveOperation', 'replayStore']) {
    assert.throws(() => createQzonePluginHostRuntime(without(key)), TypeError,
      '缺少 ' + key + ' 必须 TypeError');
  }

  assert.throws(() => createQzonePluginHostRuntime({ ...good, store: {} }), TypeError, 'store 形状');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, replayStore: { read() {} } }), TypeError,
    'replayStore 缺 update');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, botQq: 0 }), TypeError, 'botQq 必须为正');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, botQq: '123' }), TypeError, 'botQq 不得为字符串');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, sourceEpoch: '' }), TypeError, '空 sourceEpoch');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, sourceEpoch: 'bad epoch!' }), TypeError,
    'sourceEpoch 字符集');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, clock: 1 }), TypeError, 'clock 非函数');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, call: 'x' }), TypeError, 'call 非函数');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, getConnectionEpoch: 8 }), TypeError,
    'getConnectionEpoch 非函数');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, approveOperation: true }), TypeError,
    'approveOperation 非函数');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, mode: 'write' }), TypeError, 'mode 闭集');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, sessionLimit: 0 }), TypeError, 'sessionLimit 下界');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, trackingLimit: 4097 }), TypeError,
    'trackingLimit 上界');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, writeWiring: null }), TypeError, 'writeWiring null');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, writeWiring: [] }), TypeError, 'writeWiring 数组');
  // A misspelt dependency must not be ignored: it would look like "writes were wired".
  assert.throws(() => createQzonePluginHostRuntime({ ...good, writeWirring: {} }), TypeError,
    '未知键不得被静默忽略');
  assert.throws(() => createQzonePluginHostRuntime({ ...good, [Symbol('x')]: true }), TypeError,
    'symbol 键同样拒绝');
  // An accessor would run caller code once and pin its result: refuse instead of reading it.
  const withGetter = { ...good };
  Object.defineProperty(withGetter, 'botQq', { enumerable: true, get: () => ACCOUNT });
  assert.throws(() => createQzonePluginHostRuntime(withGetter), TypeError, 'accessor 必须被拒');

  // Control: the valid base really does construct, so the throws above are about the fault.
  const host = createQzonePluginHostRuntime(good);
  assert.equal(typeof host.dispatch, 'function');
  assert.equal(host.teardown(), true);
});

// ============================================================================================
// 2. THE SURFACE the plugin consumes
// ============================================================================================
test('PH-2 构造成功 ⇒ epoch/dispatch/sourceLifetime 齐全，status 不自称开启写', (t) => {
  const w = world(t);
  const host = w.build();
  assert.equal(typeof host.epoch, 'string');
  assert.ok(host.epoch.length > 0, 'epoch 必须非空（插件据此判定 ready）');
  assert.equal(host.epoch, EPOCH);
  assert.equal(typeof host.dispatch, 'function');
  assert.equal(typeof host.status, 'function');
  assert.equal(typeof host.teardown, 'function');
  assert.equal(typeof host.sourceLifetime, 'object');
  assert.equal(typeof host.sourceLifetime.sourceEpoch, 'function');
  assert.equal(typeof host.sourceLifetime.getLedger, 'function');
  assert.equal(typeof host.sourceLifetime.invalidate, 'function');
  assert.equal(host.sourceLifetime.sourceEpoch(), EPOCH, '★ sourceEpoch() 与传入一致');
  assert.equal(Object.isFrozen(host), true, '★ 句柄冻结');
  assert.equal(Object.isFrozen(host.sourceLifetime), true, '★ lifetime 冻结');

  const status = host.status();
  assert.equal(status.tornDown, false);
  assert.equal(status.mode, 'read-only', '★ 省略 mode ⇒ 闭合默认 read-only（只会减少能力）');
  assert.equal(status.sourceEpoch, EPOCH);
  assert.deepEqual(status.writeWiring, { supplied: false, status: 'not-supplied', actions: [] },
    '★★ 未装配写必须如实报告，不得谎报可用');
  assert.deepEqual(status.ledgers, { count: 0, limit: 256, trackingLimit: 4096, sessions: [] },
    '★ status 本身不创建任何 ledger');
  assert.equal(Object.isFrozen(status), true);
  host.teardown();
});

// ============================================================================================
// 3. LEDGER LIFECYCLE — one per session, reused, replaced only on invalidate
// ============================================================================================
test('PH-3 同一 session 复用同一 ledger；invalidate 后换新对象且旧的已死', (t) => {
  const w = world(t);
  const host = w.build();
  const first = host.sourceLifetime.getLedger(SESSION);
  const again = host.sourceLifetime.getLedger(SESSION);
  assert.equal(again, first, '★★★ 同一 session 必须复用同一对象（否则 replay 保护会被清空）');
  assert.equal(typeof first.registerBridgeRequest, 'function');
  assert.equal(typeof first.ownsConsumption, 'function');
  assert.equal(first.alive(), true);
  const other = host.sourceLifetime.getLedger('s2');
  assert.notEqual(other, first, '不同 session 是不同账本');
  assert.equal(host.status().ledgers.count, 2);
  assert.deepEqual(host.status().ledgers.sessions, ['s1', 's2']);

  assert.throws(() => host.sourceLifetime.getLedger('bad id!'), TypeError, '会话 id 字符集');
  assert.equal(host.sourceLifetime.invalidate('never-seen'), false, '无账本时 invalidate 返回 false');
  assert.equal(host.sourceLifetime.invalidate(SESSION), true);
  assert.equal(first.alive(), false, '★★ 被失效的账本必须已经断开（冻结对象的单向闩锁）');
  const fresh = host.sourceLifetime.getLedger(SESSION);
  assert.notEqual(fresh, first, '★★★ invalidate 之后必须是新对象');
  assert.equal(fresh.alive(), true);
  assert.equal(host.status().ledgers.count, 2, 's2 + 新的 s1');
  host.teardown();
});

// ============================================================================================
// 4. THE SOURCE IS NOT SELF-REPORTED
// ============================================================================================
test('PH-4 伪造 context 拿不到来源：无账本/无位置 ⇒ origin-unverified，且不新建账本、不调 call', async (t) => {
  const w = world(t);
  const host = w.build({ mode: 'enabled' });

  // (a) a session this module holds no ledger for: a dispatch must NOT mint one.
  const unknown = await host.dispatch('publish', PUBLISH_INPUT, { sessionId: 's-never', callId: 'c1' });
  assert.deepEqual(unknown, { ok: false, error: 'origin-unverified' });
  assert.equal(host.status().ledgers.count, 0, '★★★ dispatch 绝不为自报的 session 新建账本');

  // (b) a session with a ledger, but a callId that was never observed: no position, no source.
  host.sourceLifetime.getLedger(SESSION);
  const unobserved = await host.dispatch('publish', PUBLISH_INPUT, { sessionId: SESSION, callId: 'c1' });
  assert.deepEqual(unobserved, { ok: false, error: 'origin-unverified' });
  assert.equal(w.calls.length, 0, '★★ 一次平台 call 都没有');
  assert.equal(w.sent.length, 0);

  // (c) malformed context is refused before anything else.
  assert.deepEqual(await host.dispatch('publish', PUBLISH_INPUT, null),
    { ok: false, error: 'missing-native-context' });
  assert.deepEqual(await host.dispatch('publish', PUBLISH_INPUT, { sessionId: SESSION }),
    { ok: false, error: 'missing-native-context' });
  host.teardown();
});

test('PH-5 authorizeSource 真的落在账本上：别的账本签发的 consumption 被拒', async (t) => {
  const w = world(t);
  const host = w.build({ mode: 'enabled' });
  const genuine = host.sourceLifetime.getLedger(SESSION);
  const ids = w.position(genuine);

  // A DIFFERENT ledger object for the SAME session id and the same epoch: structurally
  // identical, but it is not the ledger this runtime owns.
  const foreign = createQzoneOriginLedger({ sessionId: SESSION, epoch: EPOCH });
  foreign.registerBridgeRequest({ requestId: 'foreign-r', origin: 'qq-inbound' });
  assert.equal(foreign.observeStep({ sessionId: SESSION, turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'foreign-r' } }] }), true);
  assert.equal(foreign.observeToolCall({ sessionId: SESSION,
    event: { type: 'tool/call', data: { turn: 1, step: 1, callId: ids.callId } } }), true);
  const stolen = foreign.consume({ sessionId: SESSION, turn: 1, step: 1, callId: ids.callId });
  assert.ok(stolen, '前提：foreign 账本确实签发了一个 consumption');

  const refused = await host.dispatch('publish', PUBLISH_INPUT, { ...ids, binding: stolen });
  assert.deepEqual(refused, { ok: false, error: 'origin-unverified' },
    '★★★ 不是本模块账本签发的 consumption 必须被拒（authorizeSource 不是恒 true）');
  assert.equal(w.sent.length, 0);
  assert.equal(w.calls.length, 0);
  host.teardown();
});

// ============================================================================================
// 5. DEFAULT CLOSED — no writeWiring means the runtime's own refusals, verbatim
// ============================================================================================
test('PH-6 不传 writeWiring ⇒ comment 被拒 write-not-wired、publish origin-unverified，send 0', async (t) => {
  const w = world(t);
  const host = w.build({ mode: 'enabled' });
  const ledger = host.sourceLifetime.getLedger(SESSION);

  const commentIds = w.position(ledger);
  const comment = await host.dispatch('comment', COMMENT_INPUT, commentIds);
  assert.deepEqual(comment, { ok: false, error: 'write-not-wired' }, '★★★ 缺省失败关闭');

  const publishIds = w.position(ledger);
  const publish = await host.dispatch('publish', PUBLISH_INPUT, publishIds);
  assert.deepEqual(publish, { ok: false, error: 'origin-unverified' },
    '★ publish 无 target_uin，老拒绝原因原样保留');

  assert.equal(w.sent.length, 0, '★★★ 零次 send');
  assert.equal(w.calls.length, 0, '★★ 零次平台 call');
  host.teardown();
});

test('PH-7 显式 writeWiring: undefined 等同省略（不得被当成已装配）', async (t) => {
  const w = world(t);
  const host = w.build({ mode: 'enabled', writeWiring: undefined });
  assert.equal(host.status().writeWiring.supplied, false, '★ status 如实报告未装配');
  const ids = w.position(host.sourceLifetime.getLedger(SESSION));
  const result = await host.dispatch('comment', COMMENT_INPUT, ids);
  assert.deepEqual(result, { ok: false, error: 'write-not-wired' });
  assert.equal(w.sent.length, 0);
  host.teardown();
});

test('PH-8 传了 writeWiring 但 mode 省略（默认 read-only）⇒ write-not-enabled，send 0', async (t) => {
  const w = world(t);
  const host = w.build({ writeWiring: w.wiring() });
  assert.equal(host.status().mode, 'read-only');
  assert.equal(host.status().writeWiring.status, 'wired', '★ 结构完整就如实说 wired（能力仍受 mode 限制）');
  const ids = w.position(host.sourceLifetime.getLedger(SESSION));
  const result = await host.dispatch('comment', COMMENT_INPUT, ids);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'write-not-enabled', '★★★ 默认关闭：省略 mode 不得开写');
  assert.equal(w.sent.length, 0);
  assert.equal(w.approvals.length, 0, '★ 未获准的写不应先问审批');
  host.teardown();
});

// ============================================================================================
// 6. EXPLICIT OPT-IN — the write really reaches the injected fake send
// ============================================================================================
test('PH-9 writeWiring + mode enabled + approve true ⇒ 走到假 send（payload 记录），无真实网络', async (t) => {
  const w = world(t);
  const host = w.build({ mode: 'enabled', writeWiring: w.wiring() });
  assert.equal(host.status().writeWiring.status, 'wired');
  const ids = w.position(host.sourceLifetime.getLedger(SESSION));

  const result = await host.dispatch('comment', COMMENT_INPUT, ids);
  assert.equal(result.ok, true, '★★★ 显式接线后应当成功: ' + JSON.stringify(result));
  assert.equal(result.outcome, 'success');
  assert.equal(result.sent, true);
  assert.equal(w.approvals.length >= 1, true, '★ 宿主审批确实被问到');
  assert.equal(w.approvals[0].action, 'comment');
  assert.equal(w.approvals[0].sessionId, SESSION);
  assert.equal(w.approvals[0].inputDigest.length, 64, '★ 审批看到的是带摘要的冻结操作');
  assert.equal(w.sent.length, 1, '★★★ send 恰好一次');
  assert.deepEqual(w.sent[0], {
    action: 'comment_qzone',
    params: { tid: 'post-1', target_uin: 456, content: 'nice post' },
  }, '★★ 发给假 send 的就是平台请求（参数未被改写）');
  assert.equal(w.calls.length, 0, '★★★ 读传输 0 次：没有真实网络请求');
  const dsp = (w.store.read().audit ?? []).filter((entry) => String(entry.id).startsWith('dsp_'));
  assert.equal(dsp.length, 1);
  assert.equal(dsp[0].record.result, 'success');
  host.teardown();
});

test('PH-10 approveOperation 回答 false ⇒ 不发送（not-authorized）', async (t) => {
  const w = world(t);
  let asked = 0;
  const host = w.build({
    mode: 'enabled',
    writeWiring: w.wiring(),
    approveOperation: () => { asked += 1; return false; },
  });
  const ids = w.position(host.sourceLifetime.getLedger(SESSION));
  const result = await host.dispatch('comment', COMMENT_INPUT, ids);
  assert.equal(result.ok, false, '★★★ 未获批准不得成功: ' + JSON.stringify(result));
  assert.equal(result.reason, 'not-authorized', '★ 拒绝词汇来自写组合，未被本模块改写');
  assert.equal(asked >= 1, true, '★ 确实问了宿主');
  assert.equal(w.sent.length, 0, '★★★ 零次 send');
  assert.equal(w.calls.length, 0);
  host.teardown();
});

test('PH-11 approveOperation 抛错 ⇒ 依旧不发送（fail-closed）', async (t) => {
  const w = world(t);
  const host = w.build({
    mode: 'enabled',
    writeWiring: w.wiring(),
    approveOperation: () => { throw new Error('approval channel down'); },
  });
  const ids = w.position(host.sourceLifetime.getLedger(SESSION));
  const result = await host.dispatch('comment', COMMENT_INPUT, ids);
  assert.equal(result.ok, false);
  assert.equal(w.sent.length, 0, '★★★ 审批通道故障绝不能发出写');
  host.teardown();
});

test('PH-12 replayStore 未初始化 ⇒ 写被拒且不发送（不伪造 B2 声明）', async (t) => {
  const w = world(t, { replay: false });
  const host = w.build({ mode: 'enabled', writeWiring: w.wiring() });
  const ids = w.position(host.sourceLifetime.getLedger(SESSION));
  const result = await host.dispatch('publish', PUBLISH_INPUT, ids);
  assert.equal(result.ok, false, '★★ 未初始化的 replay 存储不得放行: ' + JSON.stringify(result));
  assert.equal(w.sent.length, 0, '★★★ 零次 send');
  assert.equal(host.status().writeWiring.status, 'wired', '★ 报告的是接线结构，不是平台结果');
  host.teardown();
});

// ============================================================================================
// 7. TEARDOWN
// ============================================================================================
test('PH-13 teardown 幂等：断开账本、停止供源、不关外部 store', async (t) => {
  const w = world(t);
  const host = w.build({ mode: 'enabled' });
  const ledger = host.sourceLifetime.getLedger(SESSION);
  const ids = w.position(ledger);

  assert.equal(host.teardown(), true, '★ 首次 teardown 报告一次');
  assert.equal(host.teardown(), false, '★★ 幂等');
  assert.equal(ledger.alive(), false, '★★ 它创建的账本被断开');
  assert.equal(host.status().ledgers.count, 0, '★ 缓存已清空');
  assert.equal(host.status().sourceEpoch, null, '★★ 世代已退役（插件据此清缓存）');
  assert.equal(host.sourceLifetime.sourceEpoch(), null);
  assert.throws(() => host.sourceLifetime.getLedger(SESSION), Error, 'teardown 后不再签发账本');
  assert.equal(host.sourceLifetime.invalidate(SESSION), false);

  // AFTER teardown a dispatch keeps the RUNTIME's own vocabulary: the ledger is gone, so the
  // origin check refuses it exactly as it refuses any other unbound call. This module adds no
  // private error word to the surface (see the dispatch doc comment).
  const after = await host.dispatch('publish', PUBLISH_INPUT, ids);
  assert.deepEqual(after, { ok: false, error: 'origin-unverified' }, '★ 死句柄随 runtime 词汇拒绝');
  assert.equal(w.sent.length, 0, '★★ 退役之后也绝不发送');
  assert.equal(w.calls.length, 0);
  // The injected store belongs to the caller: it must still be usable and must NOT be closed.
  assert.equal(typeof w.store.read(), 'object');
  w.store.update((state) => ({ ...state, reads: state.reads + 1 }));
  assert.equal(w.store.read().reads, 1, '★★ 本模块绝不 close 外部注入的 store');
});

// ============================================================================================
// 8. THE REAL PLUGIN — the returned object is what createQzonePluginHandle needs
// ============================================================================================
test('PH-14 真插件消费本对象 ⇒ enabled-dispatch-ready，且账本由本模块签发', async (t) => {
  const w = world(t);
  const host = w.build({ mode: 'enabled' });
  const subscriptions = new Map();
  const registered = new Map();
  const ctx = {
    on(name, listener) {
      const list = subscriptions.get(name) ?? [];
      list.push(listener);
      subscriptions.set(name, list);
      return () => { const i = list.indexOf(listener); if (i >= 0) list.splice(i, 1); };
    },
    tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
  };
  const handle = await createQzonePluginHandle(ctx, { enabled: true }, {
    dispatch: host.dispatch,
    epoch: host.epoch,
    sourceLifetime: host.sourceLifetime,
    defineTool: (tool) => tool,
  });
  t.after(async () => { try { await handle.dispose(); } catch { /* already gone */ } });

  const status = handle.status();
  assert.equal(status.state, STATES.DISPATCH_READY, '★★★ 插件必须进入 enabled-dispatch-ready');
  assert.equal(status.tools > 0, true, '★ 工具已注册');
  assert.equal(status.generationBound, true, '★ 代际一致（插件的 sourceEpoch 比较通过）');
  assert.equal(status.dispatchAvailable, false, '★ 还没有 agent ⇒ 诚实地报 false');
  assert.equal(registered.has('qzone_read_posts'), true);

  // The plugin's own ledger lookup goes THROUGH our lifetime and our cache.
  handle.registerBridgeRequest(SESSION, { requestId: 'plugin-r', origin: 'qq-inbound' });
  assert.equal(host.status().ledgers.count, 1, '★★★ 插件取的账本由本模块签发并缓存');
  const ourLedger = host.sourceLifetime.getLedger(SESSION);
  assert.equal(typeof ourLedger.peekCall, 'function');

  await handle.dispose();
});

// ============================================================================================
// 9. THE HARDER DEFAULT-CLOSED QUESTION — the plugin's own tool surface, over OUR host object
// ============================================================================================
test('PH-15 插件链路 dispatchAvailable=true 且 mode=enabled，仍无 writeWiring ⇒ 零 send', async (t) => {
  const w = world(t);
  const host = w.build({ mode: 'enabled' });
  const agentSubscriptions = new Map();
  const hostSubscriptions = new Map();
  const registered = new Map();
  const on = (map) => (name, listener) => {
    const list = map.get(name) ?? [];
    list.push(listener);
    map.set(name, list);
    return () => { const i = list.indexOf(listener); if (i >= 0) list.splice(i, 1); };
  };
  const ctx = {
    on: on(hostSubscriptions),
    tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
  };
  const handle = await createQzonePluginHandle(ctx, { enabled: true }, {
    dispatch: host.dispatch,
    epoch: host.epoch,
    sourceLifetime: host.sourceLifetime,
    defineTool: (tool) => tool,
  });
  t.after(async () => { try { await handle.dispose(); } catch { /* already gone */ } });
  const emit = (name, ...args) => {
    for (const listener of hostSubscriptions.get(name) ?? []) listener(...args);
  };

  // Real host events: an agent on s1, a bridge request, the pre-step citing it, one tool/call.
  emit('agent/created', {
    agent: { id: 'agent-1', session: { id: SESSION }, ctx: { on: on(agentSubscriptions) } },
  });
  assert.equal(handle.status().dispatchAvailable, true, '前提：这个 session 真的可派发');
  handle.registerBridgeRequest(SESSION, { requestId: 'r-1', origin: 'qq-inbound' });
  for (const listener of agentSubscriptions.get('agent/pre-step') ?? []) {
    listener({ turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'r-1' } }] }, () => {});
  }
  emit('session/event', { id: SESSION }, {
    type: 'tool/call', data: { turn: 1, step: 1, callId: 'plugin-call-1', name: 'qzone_comment' },
  });

  const tool = registered.get('qzone_comment');
  assert.equal(typeof tool?.execute, 'function', '前提：写工具已注册');
  const result = await tool.execute(COMMENT_INPUT, {
    agent: { session: { id: SESSION } }, callId: 'plugin-call-1',
  });
  assert.deepEqual(result, { ok: false, error: 'write-not-wired' },
    '★★★ 默认关闭：插件整条链路也发不出写');
  assert.equal(w.sent.length, 0, '★★★ 零次 send');
  assert.equal(w.calls.length, 0, '★★ 零次平台 call');
  assert.equal(w.approvals.length, 0, '★ 没有写就不该打扰审批');
});

// ============================================================================================
// 10. THE WIRING IS FORWARDED VERBATIM — an incomplete or mistyped one is refused, never repaired
// ============================================================================================
test('PH-16 不完整的 writeWiring ⇒ status 如实报 incomplete，写被拒 write-wiring-incomplete，send 0', async (t) => {
  const w = world(t);
  // An EMPTY actions list is the shape buildWriteWiring marks complete:false, and the runtime
  // then refuses every write with its own closed error instead of silently sending.
  const host = w.build({ mode: 'enabled', writeWiring: w.wiring({ actions: [] }) });
  assert.deepEqual(host.status().writeWiring, { supplied: true, status: 'incomplete', actions: [] },
    '★★ 不完整接线必须如实报 incomplete，不得谎报可用');
  const ids = w.position(host.sourceLifetime.getLedger(SESSION));
  const result = await host.dispatch('comment', COMMENT_INPUT, ids);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'write-wiring-incomplete', '★★ 拒绝词汇来自 runtime，本模块没有改写');
  assert.equal(w.sent.length, 0);
  assert.equal(w.approvals.length, 0);
  host.teardown();
});

test('PH-17 writeWiring 里的未知键 ⇒ TypeError（原样透传 runtime 的封闭键集）', async (t) => {
  const w = world(t);
  assert.throws(() => w.build({ mode: 'enabled', writeWiring: w.wiring({ bogus: true }) }), TypeError,
    '★★ 未知 writeWiring 键不得被本模块吞掉');
  // A supplied-but-unusable audit sink is NOT a TypeError: `buildWriteWiring` maps it to
  // {complete:false} on purpose, so that a mistyped write dependency cannot take the whole
  // READ path down with it (qzone-runtime-wiring.mjs:107-140). It must still be a closed
  // refusal at dispatch time and must still be reported as incomplete by status().
  const broken = w.build({ mode: 'enabled', writeWiring: w.wiring({ audit: {} }) });
  assert.equal(broken.status().writeWiring.status, 'incomplete', '★ 坏 audit sink ⇒ incomplete');
  const wiringIds = w.position(broken.sourceLifetime.getLedger(SESSION));
  const refused = await broken.dispatch('comment', COMMENT_INPUT, wiringIds);
  assert.equal(refused.error, 'write-wiring-incomplete');
  assert.equal(w.sent.length, 0, '★ 坏 audit sink 也不得发出写');
  broken.teardown();
});


// ============================================================================================
// 11. status() IS A PURE PROBE — a monitoring loop must not be able to change the runtime
// ============================================================================================
test('PH-18 status 纯读：反复调用不建账本、不读时钟、不写 store、不影响后续派发', async (t) => {
  const w = world(t);
  let clockReads = 0;
  const host = w.build({
    mode: 'enabled',
    clock: () => { clockReads += 1; return NOW; },
  });
  const snapshot = w.store.read();
  const before = clockReads;
  for (let i = 0; i < 50; i += 1) host.status();
  assert.equal(clockReads, before, '★★ status 不读时钟');
  assert.equal(host.status().ledgers.count, 0, '★★ status 不创建账本');
  assert.deepEqual(w.store.read(), snapshot, '★★ status 不写 store');

  // The runtime is still fully usable afterwards: the probe latched nothing.
  const ids = w.position(host.sourceLifetime.getLedger(SESSION));
  const result = await host.dispatch('comment', COMMENT_INPUT, ids);
  assert.deepEqual(result, { ok: false, error: 'write-not-wired' }, '★ 探测之后行为不变');
  host.teardown();
});


// ============================================================================================
// 12. THE CROSS-PROCESS SHAPE — an ASYNC approveOperation (the IPC client's signature)
// ============================================================================================
// The sibling approval-channel module returns `{ approveOperation: (op) => Promise<boolean> }`
// (qzone-approval-ipc-client.mjs:108). Nothing here opens a socket: the promise is a local
// fixture that merely RESOLVES the way a remote answer would, so what is proven is that this
// assembly carries an asynchronous verdict through unchanged — not that a channel exists.
test('PH-20 异步 approveOperation（跨进程通道的形状）⇒ resolve(true) 才发送，resolve(false) 不发送', async (t) => {
  const w = world(t);
  const answers = [];
  let verdict = true;
  const host = w.build({
    mode: 'enabled',
    writeWiring: w.wiring(),
    approveOperation: async (operation) => { answers.push(operation); return verdict; },
  });
  const ledger = host.sourceLifetime.getLedger(SESSION);

  const first = w.position(ledger);
  const sent = await host.dispatch('comment', COMMENT_INPUT, first);
  assert.equal(sent.ok, true, '★★ 异步 true 必须放行: ' + JSON.stringify(sent));
  assert.equal(w.sent.length, 1, '★★★ send 恰好一次');

  // The write path's own 3-minute comment interval would refuse the second comment BEFORE any
  // approval, so the clock is advanced: the rule is real and is not weakened for the test.
  w.live.now = NOW + 3 * 60 * 1000;
  verdict = false;
  const second = w.position(ledger);
  const refused = await host.dispatch('comment', COMMENT_INPUT, second);
  assert.equal(refused.ok, false, '★★★ 异步 false 必须拒绝: ' + JSON.stringify(refused));
  assert.equal(refused.reason, 'not-authorized', '★ 拒绝的原因是审批，不是配额');
  assert.equal(w.sent.length, 1, '★★★ 拒绝时不再发送（总数仍是 1）');
  assert.equal(answers.length, 2, '★ 两次都真的问了审批');
  assert.equal(w.calls.length, 0, '★★ 读传输始终 0 次');
  host.teardown();
});
test('PH-21 mode=disabled ⇒ dispatch 被拒为 disabled，且零 send / 零 call', async (t) => {
  const w = world(t);
  const host = w.build({ mode: 'disabled', writeWiring: w.wiring() });
  assert.equal(host.status().mode, 'disabled');
  const ledger = host.sourceLifetime.getLedger(SESSION);
  const ids = w.position(ledger);
  const result = await host.dispatch('comment', COMMENT_INPUT, ids);
  assert.deepEqual(result, { ok: false, error: 'disabled' });
  assert.equal(w.sent.length, 0);
  assert.equal(w.calls.length, 0);
  host.teardown();
});
