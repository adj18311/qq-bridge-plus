// The runtime's OPT-IN write wiring: `createQzoneRuntime({ writeWiring })`.
//
// What is REAL here (no stub of our own):
//   · a real temporary SQLite state store (`openOfflineStore`) with a real, initialized B2 replay
//     collection (`initializeReplayState`);
//   · the REAL origin ledger, and BOTH of the runtime's consumption branches — a caller-supplied
//     branded `consumption` (branch A) and the runtime's own `peekCall`/`consume` (branch B);
//   · the REAL host-approved operation authorizer (`createQzoneOperationAuthorizer`) — the very
//     instance the runtime builds from `operationAuthorization`;
//   · the REAL offline write path (`createOfflineWritePath`: gate -> reserve -> final check ->
//     transport) with its real quota ledger, cooldown and B2 claim;
//   · the REAL approved-publish / approved-comment compositions, called through the runtime.
//
// What is a FIXTURE, and only this:
//   · `approveOperation` — the host's verdict (there is no human in a test);
//   · `send` — the OneBot call itself is never made; it records the payload and answers `{ok:true}`;
//   · `clock` — pinned so the quota day and the intervals are deterministic.
//
// ⚠️ WHAT THESE TESTS DO **NOT** SHOW
// -----------------------------------
//   · No real QQ/OneBot request is issued and nothing is posted, commented or liked anywhere. A
//     `send` count here proves the composition reached the transport boundary of THIS process and
//     nothing beyond it.
//   · `publish` reserves through the write path's NON-audited entry point, so the composition
//     writes no intent and no settlement for it (only the runtime's own `dsp_` dispatch row). The
//     audit vocabulary has no field for `ugc_right`/`target_uins` at all, so no audit row — here or
//     in production — can prove what visibility a post was published with. The PAYLOAD is asserted
//     directly instead.
//   · `reply` additionally needs the reservation layer's store-backed `commentEvidence` gate, which
//     this file therefore does not drive for the write itself. The three interaction actions are
//     covered by `comment`, which has no evidence precondition.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import { createQzoneOriginLedger, isOriginLedgerConsumption } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

const NOW = Date.parse('2026-11-15T04:00:00Z');
const ACCOUNT = 123;
const SESSION = 's1';
const REQUEST = 'request-1';
const TWO_HOURS = 7200000;

const COMMENT_INPUT = Object.freeze({ tid: 'post-1', target_uin: 456, content: 'nice post' });
const REPLY_INPUT = Object.freeze({ tid: 'post-1', target_uin: 456, content: 'reply body', comment_id: 'cm-1', comment_uin: 7 });
const LIKE_INPUT = Object.freeze({ tid: 'post-1', target_uin: 456 });
const PUBLISH_INPUT = Object.freeze({ content: 'hello world', ugc_right: 1 });

/** Every field the real store needs for the write path's gate, reservation and quota ledger. */
function initialState(now = NOW) {
  return {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 10, comment: 25, like: 30 },
    ledger: { day: beijingDay(now), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
    reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    browseDay: beijingDay(now), todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [],
    // `notices` is REQUIRED by the read settlement (`qzone-settlement-offline.mjs` throws
    // `invalid read state` without it), so a fixture without it turns every read into `unknown`
    // for a reason that has nothing to do with this change. It is here because a real store has it.
    notices: [],
  };
}

/**
 * One world. `build()` creates a FRESH runtime + ledger over the SAME store, which is how the
 * "same quadruple, second runtime" case is reached without pretending one runtime's in-memory
 * `seenCalls` is the durable claim.
 */
function world(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-runtime-write-'));
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  });
  const store = options.store ?? openOfflineStore(path.join(dir, 'state.db'), initialState(options.now ?? NOW));
  if (options.store === undefined) t.after(() => { try { store.close(); } catch {} });
  if (options.initialize !== false) assert.equal(initializeReplayState(store, { now: NOW }).ok, true, '前提：replay 集合已初始化');

  const live = { now: options.now ?? NOW, epoch: 8, source: true };
  const sent = [];
  const calls = [];
  const approvals = [];
  const send = async (payload) => {
    sent.push(payload);
    return options.send === undefined ? { ok: true } : options.send(payload);
  };
  const writePath = (transport) => createOfflineWritePath({ store, clock: () => live.now, transport });
  const defaultWiring = { send, writePath, source: 'qq', actions: ['publish', 'comment', 'reply', 'like'] };
  const wiring = (overrides = {}) => ({ ...defaultWiring, ...overrides });

  function build(buildOptions = {}) {
    const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
    ledger.registerBridgeRequest({ requestId: REQUEST, origin: 'qq-inbound' });
    assert.equal(ledger.observeStep({
      sessionId: SESSION, turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: REQUEST } }],
    }), true);
    const runtimeOptions = {
      store, botQq: ACCOUNT, sourceEpoch: 'e1',
      getConnectionEpoch: () => live.epoch,
      authorizeSource: (consumption) => live.source === true && ledger.ownsConsumption(consumption),
      getBridgeSessions: (sessionId) => (sessionId === SESSION ? ledger : null),
      clock: () => live.now,
      mode: buildOptions.mode ?? options.mode ?? 'enabled',
      call: async (action) => {
        calls.push(action);
        if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: ACCOUNT } };
        if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: 456 }] };
        if (action === 'get_qzone_msg_list') {
          return { status: 'ok', retcode: 0,
            data: { total: 1, msglist: [{ tid: 'post', time: NOW / 1000 - 5, content: 'recent' }] } };
        }
        throw new Error(`unexpected fixture action ${action}`);
      },
    };
    if (buildOptions.overrideSource) Object.assign(runtimeOptions, buildOptions.overrideSource);
    if (buildOptions.operationAuthorization !== 'none') {
      runtimeOptions.operationAuthorization = {
        replayStore: store,
        approveOperation: (operation) => {
          approvals.push(operation);
          return options.approve === undefined ? true : options.approve(operation);
        },
      };
    }
    const wiringValue = 'writeWiring' in buildOptions
      ? buildOptions.writeWiring
      : ('writeWiring' in options ? options.writeWiring : defaultWiring);
    // ABSENT means "not opted in": the key must not be present at all, because the runtime
    // distinguishes an absent option from an explicit `undefined` value it can read.
    if (wiringValue !== undefined) runtimeOptions.writeWiring = wiringValue;
    return { runtime: createQzoneRuntime(runtimeOptions), ledger };
  }

  return {
    store, live, sent, calls, approvals, send, writePath, wiring, build,
    /** One dispatch. `binding:true` uses the CALLER-supplied branded consumption branch. */
    dispatch(pair, action, input, { callId = 'c1', binding = false } = {}) {
      assert.equal(pair.ledger.observeToolCall({
        sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId } },
      }), true, '前提：tool/call 已记录');
      const consumption = binding ? pair.ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId }) : null;
      if (binding) assert.equal(isOriginLedgerConsumption(consumption), true, '前提：这是真实账本签发的 consumption');
      const ctx = { sessionId: SESSION, callId };
      if (consumption) ctx.binding = consumption;
      return pair.runtime.dispatch(action, input, ctx);
    },
    claimedKeys() { return Object.keys(store.read().usedReadKeys ?? {}); },
    auditRows() { return store.read().audit ?? []; },
  };
}

// ── 1. DEFAULT OFF: the four write tools keep their pre-existing refusals, verbatim ────────────
test('write rejects a genuine consumption from another session even if the host callback accepts it', async (t) => {
  const w = world(t);
  const foreign = createQzoneOriginLedger({ sessionId: 'other-session', epoch: 'e1' });
  foreign.registerBridgeRequest({ requestId: REQUEST, origin: 'qq-inbound' });
  assert.equal(foreign.observeStep({ sessionId: 'other-session', turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: REQUEST } }] }), true);
  assert.equal(foreign.observeToolCall({ sessionId: 'other-session',
    event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1' } } }), true);
  const foreignConsumption = foreign.consume({ sessionId: 'other-session', turn: 1, step: 1, callId: 'c1' });
  assert.equal(isOriginLedgerConsumption(foreignConsumption), true);
  const pair = w.build({ overrideSource: {
    authorizeSource: () => true,
    getBridgeSessions: () => ({ peekCall: () => ({ turn: 1, step: 1 }), consume: () => foreignConsumption }),
  } });
  const result = await w.dispatch(pair, 'publish', PUBLISH_INPUT);
  assert.deepEqual(result, { ok: false, error: 'origin-unverified' });
  assert.deepEqual(w.sent, []);
  assert.deepEqual(w.claimedKeys(), []);
});

test('WW-1 默认关闭：不传 writeWiring 时写口径一字不变（publish 仍 origin-unverified，其余 write-not-wired），send 0', async (t) => {
  for (const mode of ['enabled', 'read-only']) {
    const w = world(t, { mode, writeWiring: undefined });
    const pair = w.build();
    const cases = [
      ['comment', COMMENT_INPUT, { ok: false, error: 'write-not-wired' }],
      ['reply', REPLY_INPUT, { ok: false, error: 'write-not-wired' }],
      ['like', LIKE_INPUT, { ok: false, error: 'write-not-wired' }],
      // publish carries no single `target_uin`, so the trusted binding mint fails BEFORE the write
      // gate and the pre-existing refusal is the earlier one. It is asserted exactly so that a
      // "helpful" `target_uins[0]` fallback cannot land unnoticed.
      ['publish', PUBLISH_INPUT, { ok: false, error: 'origin-unverified' }],
    ];
    for (const [index, [action, input, expected]] of cases.entries()) {
      const result = await w.dispatch(pair, action, input, { callId: `off-${mode}-${index}` });
      assert.deepEqual(result, expected, `mode=${mode} action=${action}`);
    }
    assert.deepEqual(w.sent, [], `mode=${mode}：默认关闭时不得有任何发送`);
    assert.deepEqual(w.claimedKeys(), [], `mode=${mode}：不得占用任何 B2 键`);
  }
});

// ── 2. OPTED IN BUT INCOMPLETE: controlled refusal, never half-open, never a crash ─────────────
test('WW-2 opt-in 但缺依赖 ⇒ 四个写全部 write-wiring-incomplete、send 0、不崩（读路径不受影响）', async (t) => {
  // (a) `send` missing.
  const missingSend = world(t, { writeWiring: undefined });
  const pairA = missingSend.build({ writeWiring: { writePath: missingSend.writePath, source: 'qq' } });
  const four = [['publish', PUBLISH_INPUT], ['comment', COMMENT_INPUT], ['reply', REPLY_INPUT], ['like', LIKE_INPUT]];
  for (const [index, [action, input]] of four.entries()) {
    const result = await missingSend.dispatch(pairA, action, input, { callId: `inc-${index}` });
    assert.deepEqual(result, { ok: false, error: 'write-wiring-incomplete' }, `缺 send / ${action}`);
  }
  assert.deepEqual(missingSend.sent, [], '缺 send 时不得发送');
  assert.deepEqual(missingSend.claimedKeys(), [], '缺 send 时不得占用 B2');
  assert.equal(missingSend.approvals.length, 0, '缺件必须在 host 审批之前被拒');

  // (b) `writePath` missing, and (c) `source` missing/unsupported: same closed answer.
  for (const wiring of [
    { send: missingSend.send, source: 'qq' },
    { send: missingSend.send, writePath: missingSend.writePath },
    { send: missingSend.send, writePath: missingSend.writePath, source: 'schedule' },
    { send: missingSend.send, writePath: missingSend.writePath, source: 'qq' },
  ]) {
    const w = world(t, { writeWiring: undefined });
    const pair = w.build({ writeWiring: wiring });
    const result = await w.dispatch(pair, 'publish', PUBLISH_INPUT, { callId: 'p1' });
    assert.deepEqual(result, { ok: false, error: 'write-wiring-incomplete' }, JSON.stringify(Object.keys(wiring)));
    assert.deepEqual(w.sent, []);
  }

  // (d) an opt-in WITHOUT `operationAuthorization` cannot compose a claim, so it must not open.
  const noAuthorization = world(t, { writeWiring: undefined });
  const pairD = noAuthorization.build({ operationAuthorization: 'none', writeWiring: noAuthorization.wiring() });
  assert.deepEqual(await noAuthorization.dispatch(pairD, 'publish', PUBLISH_INPUT, { callId: 'p1' }),
    { ok: false, error: 'write-wiring-incomplete' });
  assert.deepEqual(noAuthorization.sent, [], '没有 authorizer 时不得发送');

  // (e) an UNKNOWN key is a construction error, not a silently ignored dependency.
  const strict = world(t);
  assert.throws(() => strict.build({ writeWiring: { ...strict.wiring(), oops: 1 } }),
    /invalid write wiring dependencies/, '未知键必须在构造期抛错，不得被忽略');
  assert.throws(() => strict.build({ writeWiring: 'not-an-object' }), /invalid write wiring dependencies/);

  // (f) the READ path still works on an incomplete opt-in: the refusal is scoped to writes.
  const readBack = await missingSend.dispatch(pairA, 'read_posts', { target_uin: 456 }, { callId: 'r-incomplete' });
  assert.equal(readBack.ok, true, `读路径不得受写装配缺件影响: ${JSON.stringify(readBack)}`);
  assert.equal(readBack.outcome, 'success');
  assert.deepEqual(readBack.posts.map((post) => post.id), ['post']);
  assert.deepEqual(missingSend.sent, [], '读路径不得触发写发送');
});

// ── 3. THE HAPPY PATH: publish through the real composition ───────────────────────────────────
test('WW-3 opt-in publish 成功 ⇒ send 恰 1 次、载荷精确、B2 恰 1 条、post 桶 +1', async (t) => {
  const w = world(t);
  const pair = w.build();
  const result = await w.dispatch(pair, 'publish', PUBLISH_INPUT, { callId: 'c1' });

  assert.equal(result.ok, true, `应当成功: ${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'success');
  assert.equal(result.sent, true);
  assert.equal(result.stage, 'transport');
  assert.equal(w.sent.length, 1, 'send 必须恰好被调用一次');
  assert.equal(w.approvals.length, 1, 'host 被问恰好一次');

  // The payload is the CONTRACT's output for the approved snapshot, and public visibility means
  // NO recipients key at all (`buildQzoneOnebotWriteRequest` throws on one).
  assert.deepEqual(w.sent[0], { action: 'send_qzone_msg', params: { content: 'hello world', ugc_right: 1 } });
  assert.deepEqual(Object.keys(w.sent[0].params).sort(), ['content', 'ugc_right']);
  assert.deepEqual(result.payload, w.sent[0], '返回里带出同一个载荷');

  assert.deepEqual(w.claimedKeys(), [JSON.stringify([ACCOUNT, SESSION, REQUEST, 'c1'])],
    'B2 键必须是 (account, session, request, call) 四元组，且恰好一条');
  assert.equal(w.store.read().ledger.used.post, 1, '配额必须恰好 +1，记在 post 桶');
  assert.equal(w.store.read().ledger.used.comment, 0);
  assert.equal(w.store.read().lastPostAt, NOW, 'lastPostAt 必须推进到本次发送时刻');

  // ONE dispatch audit row, in the EXISTING vocabulary and shape.
  const rows = w.auditRows().filter((entry) => entry.id.startsWith('dsp_'));
  assert.equal(rows.length, 1, `dispatch 审计恰好一条: ${JSON.stringify(w.auditRows())}`);
  assert.equal(rows[0].record.action, 'publish');
  assert.equal(rows[0].record.result, 'success');
  assert.equal(rows[0].record.source, 'qq');
  // publish has no platform target, so the dispatch row reports the existing "no target" value.
  assert.equal(rows[0].record.target, '0');
});

// ── 4. THE HOST SAYS NO: nothing reserved, nothing claimed, nothing sent ──────────────────────
test('WW-4 host 拒绝 ⇒ send 0、B2 0、post 桶不变，且是受控拒绝而不是抛错', async (t) => {
  const w = world(t, { approve: () => false });
  const pair = w.build();
  const result = await w.dispatch(pair, 'publish', PUBLISH_INPUT, { callId: 'c1' });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'authorize');
  assert.equal(result.reason, 'not-authorized');
  // A pre-transport refusal carries NO `sent` field at all (the composition only stamps it once the
  // write path has been entered), so "not sent" is asserted as absence rather than as `false`.
  assert.equal(Object.hasOwn(result, 'sent'), false, 'reservation 之前的拒绝不得声称任何发送状态');
  assert.equal(w.sent.length, 0, 'host 拒绝后不得发送');
  assert.deepEqual(w.claimedKeys(), [], 'host 拒绝后不得占用 B2');
  assert.equal(w.store.read().ledger.used.post, 0, 'host 拒绝后不得消耗配额');
  assert.equal(w.store.read().lastPostAt, null, 'host 拒绝后不得推进发送时钟');
  assert.equal(w.approvals.length, 1, 'host 被问恰好一次');
});

// ── 5. BOTH consumption branches reach the write chain ────────────────────────────────────────
test('WW-5 两条消费分支都能到写链：分支 A（外部传入 binding）与分支 B（现场 consume）同一条写都成功', async (t) => {
  const results = [];
  for (const binding of [true, false]) {
    const w = world(t);
    const pair = w.build();
    const result = await w.dispatch(pair, 'comment', COMMENT_INPUT, { callId: `w-${binding ? 'a' : 'b'}`, binding });
    assert.equal(result.ok, true, `branch=${binding ? 'A(binding)' : 'B(consume)'}: ${JSON.stringify(result)}`);
    assert.equal(w.sent.length, 1, `branch=${binding ? 'A' : 'B'} 必须恰好发送一次`);
    assert.deepEqual(w.sent[0],
      { action: 'comment_qzone', params: { tid: 'post-1', target_uin: 456, content: 'nice post' } },
      `branch=${binding ? 'A' : 'B'} 的载荷必须精确`);
    assert.deepEqual(w.claimedKeys(),
      [JSON.stringify([ACCOUNT, SESSION, REQUEST, `w-${binding ? 'a' : 'b'}`])],
      `branch=${binding ? 'A' : 'B'} 必须只占用自己的 B2 四元组`);
    assert.equal(w.store.read().ledger.used.comment, 1, 'comment 桶必须恰好 +1');
    results.push(w.sent[0]);
  }
  assert.deepEqual(results[0], results[1], '两条分支的同一条写必须产生同一个载荷');
});

// ── 6. THE SAME QUADRUPLE AGAIN: the durable B2 claim refuses, nothing is sent ─────────────────
test('WW-6 同一 (account,session,request,call) 第二次 ⇒ B2 拒绝、send 0、B2 仍 1 条', async (t) => {
  const w = world(t);
  const first = w.build();
  const firstResult = await w.dispatch(first, 'publish', PUBLISH_INPUT, { callId: 'c1' });
  assert.equal(firstResult.ok, true, `前置：第一次必须成功: ${JSON.stringify(firstResult)}`);
  assert.equal(w.sent.length, 1);
  assert.equal(w.claimedKeys().length, 1);

  // A replay has to be presented by a FRESH runtime: `seenCalls` is in-memory per instance, so
  // reusing the first one would be refused a step earlier and prove nothing about B2. The clock
  // moves past the 2h post interval so the quota reservation passes and the refusal is isolated
  // to the durable claim (the point of the test).
  w.live.now = NOW + TWO_HOURS + 1;
  const second = w.build();
  const secondResult = await w.dispatch(second, 'publish', PUBLISH_INPUT, { callId: 'c1' });

  assert.equal(secondResult.ok, false, `第二次不得成功: ${JSON.stringify(secondResult)}`);
  assert.equal(secondResult.sent, false);
  assert.equal(secondResult.outcome, 'not-sent');
  assert.equal(secondResult.reason, 'replay', '拒绝必须来自 B2 的四元组重放判定');
  assert.equal(w.sent.length, 1, '第二次不得产生第二次发送');
  assert.equal(w.claimedKeys().length, 1, 'B2 键仍然恰好一条（失败的重放不写入新键）');
  // The quota unit was reserved before the transport ran, and neither the write path nor this
  // composition refunds it — reported honestly through `quotaConsumed`.
  assert.equal(secondResult.quotaConsumed, true);
  assert.equal(w.store.read().ledger.used.post, 2);
});

// ── 7. mode gate: opting in must not turn `read-only` into "can write" ───────────────────────
test('WW-7 opt-in 但 mode 不是 enabled ⇒ write-not-enabled、send 0、B2 0', async (t) => {
  for (const mode of ['read-only', 'disabled']) {
    const w = world(t, { mode });
    const pair = w.build();
    // `disabled` is refused a step earlier by the existing mode check; `read-only` is the mode the
    // write gate has to answer for itself.
    const expected = mode === 'disabled' ? 'disabled' : 'write-not-enabled';
    const result = await w.dispatch(pair, 'comment', COMMENT_INPUT, { callId: 'c1' });
    assert.deepEqual(result, { ok: false, error: expected }, `mode=${mode}`);
    assert.deepEqual(w.sent, [], `mode=${mode} 不得发送`);
    assert.deepEqual(w.claimedKeys(), [], `mode=${mode} 不得占用 B2`);
  }
});

// ── 7b. an `actions` allow-list opens only what it names ─────────────────────────────────────
test('WW-7b actions 白名单只开启列出的 action：未列出者 write-action-not-composed、send 0', async (t) => {
  const w = world(t, { writeWiring: undefined });
  const pair = w.build({ writeWiring: w.wiring({ actions: ['publish'] }) });
  const published = await w.dispatch(pair, 'publish', PUBLISH_INPUT, { callId: 'p1' });
  assert.equal(published.ok, true, `列出的 publish 必须可用: ${JSON.stringify(published)}`);
  assert.equal(w.sent.length, 1);
  for (const [index, action, input] of [['c', 'comment', COMMENT_INPUT], ['r', 'reply', REPLY_INPUT], ['l', 'like', LIKE_INPUT]]) {
    const result = await w.dispatch(pair, action, input, { callId: `x-${index}` });
    assert.deepEqual(result, { ok: false, error: 'write-action-not-composed' }, `未列出的 ${action}`);
  }
  assert.equal(w.sent.length, 1, '未列出的 action 不得产生任何发送');
});

// ── 8. THE READ PATH IS UNTOUCHED ────────────────────────────────────────────────────────────
test('WW-8 读回归：opt-in 写装配下 read_posts 仍走原读路径并成功，且不触发 send', async (t) => {
  const w = world(t);
  const pair = w.build();
  const result = await w.dispatch(pair, 'read_posts', { target_uin: 456 }, { callId: 'r1' });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'success');
  assert.deepEqual(result.posts.map((post) => post.id), ['post']);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'outcome', 'posts'], '读返回体形状不得改变');
  assert.ok(w.calls.includes('get_qzone_msg_list'), '读路径仍必须调用平台读');
  assert.deepEqual(w.sent, [], '读路径不得触发 write 的 send');
  assert.equal(w.store.read().ledger.used.post, 0, '读不得消耗写配额');
});
