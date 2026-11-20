// The approved-PUBLISH dispatch, over a REAL temporary SQLite store and the REAL components it
// composes: the operation authorizer (B3 approval + B2 claim), the offline write path
// (gate -> reserve -> final check -> transport) and the OneBot write contract.
//
// Only what is genuinely external to this repository is a fixture:
//   · `approveOperation` — the host's verdict
//   · `isCurrent`        — the live-source probe
//   · `clock`            — pinned to NOW so intervals are deterministic
//   · `send`             — the platform call itself
//
// No fake consumption, no fake claimer, no fake store, no fake authorizer. From each test the
// numbers that matter are stated explicitly — how many times `send` ran, how many B2 keys exist,
// how many times the host was asked, what the payload was, what the ledger says — so a test that
// quietly stopped testing something fails on a number instead of sailing through.
//
// ⚠️ WHAT THIS FILE CANNOT SHOW, STATED UP FRONT
// ----------------------------------------------
// `publish` reserves through the write path's NON-audited entry point (`reserveOfflinePost`), so
// this composition writes NO audit row at all — no intent, no settlement, nothing. `state.audit`
// is asserted to stay EMPTY after a successful publish below. And even if a row existed, the audit
// schema (`time/source/action/target/postId/content/result/reason/quota`) has no field for
// `ugc_right` or `target_uins`: **no audit row in this subsystem can prove what visibility a post
// was published with or who its recipients were.** Those two values exist only inside the approved
// snapshot and in the built payload, and the tests below assert the payload directly instead.
//
// The payload is what proves the visibility; the audit proves nothing about it. Do not describe
// these fixtures as evidence that a real post was published with a given visibility.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState, createReplayClaimer } from '../src/core/qzone-replay-claim-offline.mjs';
import { createQzoneOriginLedger, isOriginLedgerConsumption } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneOperationAuthorizer } from '../src/core/qzone-operation-authorization-offline.mjs';
import { createOfflineWritePath, _classifyForTests } from '../src/core/qzone-write-path-offline.mjs';
import { buildQzoneOnebotWriteRequest } from '../src/core/qzone-onebot-write-contract.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { createQzonePublishAuthorizer } from '../src/core/qzone-approved-publish-dispatch-offline.mjs';

const NOW = Date.parse('2026-11-15T04:00:00Z');
const ACCOUNT = 123;
const SESSION = 's1';
const REQUEST = 'request-1';
const SOURCE = 'qq';
const TWO_HOURS = 7200000;

/** Public: visibility 1 with NO recipients. */
const PUBLIC_INPUT = Object.freeze({ content: 'hello world', ugc_right: 1 });
/** Targeted visibility: 16 requires recipients. Mixed shapes on purpose — the builder normalises. */
const TARGETED_INPUT = Object.freeze({ content: 'for you two', ugc_right: 16, target_uins: [111, '222'] });
/** Same, the other targeted visibility value. */
const TARGETED_128_INPUT = Object.freeze({ content: 'for you two as well', ugc_right: 128, target_uins: [111, '222'] });
/** Friends-only: visibility 64 takes NO recipients. */
const FRIENDS_INPUT = Object.freeze({ content: 'friends only', ugc_right: 64 });

const baseState = (now = NOW) => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  tools: { publish: true, comment: true, reply: true, like: true, read_posts: true },
  limits: { post: 10, comment: 25, like: 30 },
  ledger: { day: beijingDay(now), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null,
  lastCommentAt: null,
  commentTargets: [],
  likes: [],
  // `audit: []` — a real store always has the collection. Every publish assertion below requires it
  // to stay EMPTY, because a publish reserves through the NON-audited entry point: this composition
  // writes no intent and no outcome. A row appearing here would mean something started auditing
  // these writes, and the header's "no audit" claims would be false.
  audit: [],
  commentEvidence: [],
});

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qzone-apd-${label}-`));
}

function removeDir(t, dir) {
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  });
}

/**
 * One world: a temp SQLite file, an initialized replay collection, the real authorizer, the real
 * write path. `writeStore` and `wrapDispatch` exist so the failure modes that can only be reached at
 * the transport boundary (a broken store, a tampered dispatch) are still exercised through the REAL
 * write path instead of a hand-built stub.
 */
function fixture(t, options = {}) {
  const dir = tempDir('world');
  removeDir(t, dir);
  const store = openOfflineStore(path.join(dir, 'state.db'), options.state ?? baseState());
  t.after(() => { try { store.close(); } catch {} });
  assert.equal(initializeReplayState(store, { now: NOW }).ok, true, '前提：replay 集合已初始化');

  const live = { now: NOW, current: true };
  const approve = { calls: 0 };
  const authorizer = createQzoneOperationAuthorizer({
    store: options.replayStore ?? store,
    accountId: ACCOUNT,
    sourceEpoch: 'e1',
    clock: () => live.now,
    approveOperation: (operation) => {
      approve.calls += 1;
      return options.approveOperation === undefined ? true : options.approveOperation(operation);
    },
    isCurrent: () => live.current,
  });

  const sent = [];
  const send = async (payload) => {
    sent.push(payload);
    return options.send === undefined ? { ok: true } : options.send(payload);
  };

  const writeStore = options.writeStore ?? store;
  const writePath = (transport) => createOfflineWritePath({
    store: writeStore,
    clock: () => live.now,
    transport: options.wrapDispatch === undefined
      ? transport
      : (dispatch) => transport(options.wrapDispatch(dispatch)),
  });

  const facade = () => createQzonePublishAuthorizer({
    authorizer, writePath, send, source: SOURCE,
  });

  /** A real branded consumption. A fresh ledger per consumption: `consume()` retires a callId. */
  function consumptionFor(callId = 'cp') {
    const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
    ledger.registerBridgeRequest({ requestId: REQUEST, origin: 'qq-inbound' });
    assert.equal(ledger.observeStep({
      sessionId: SESSION, turn: 1, step: 1,
      messages: [{ role: 'user', source: { rpcId: REQUEST } }],
    }), true);
    assert.equal(ledger.observeToolCall({
      sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId } },
    }), true);
    const consumption = ledger.consume({ sessionId: SESSION, turn: 1, step: 1, callId });
    assert.equal(isOriginLedgerConsumption(consumption), true, '前提：这是真实账本签发的 consumption');
    return consumption;
  }

  const claimedKeys = () => Object.keys(store.read().usedReadKeys ?? {});

  return {
    dir, store, live, approve, authorizer, sent, facade, consumptionFor, claimedKeys,
    run(over = {}) {
      return facade().execute({
        action: 'publish',
        consumption: consumptionFor(over.callId ?? 'cp'),
        connectionEpoch: 0,
        input: PUBLIC_INPUT,
        ...over,
      });
    },
  };
}

// ── 1. public: the happy path, and the exact payload ────────────────────────────────
test('APD-1 正控 public（ugc_right 1）⇒ send 恰 1 次，载荷精确为 {action:"send_qzone_msg", params:{content, ugc_right:1}}', async t => {
  const captured = [];
  const f = fixture(t, { wrapDispatch: (dispatch) => { captured.push(dispatch); return dispatch; } });

  const result = await f.run();

  assert.equal(result.ok, true, `应当成功: ${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'success');
  assert.equal(result.sent, true);
  assert.equal(result.stage, 'transport');
  assert.equal(f.sent.length, 1, 'send 必须恰好被调用一次');
  assert.equal(f.approve.calls, 1, 'host 被问恰好一次');
  assert.equal(result.quotaConsumed, true);

  // ── the payload, EXACTLY ────────────────────────────────────────────────────────────
  // Public visibility ⇒ NO `target_uins` key at all. The builder throws `unexpected recipients`
  // if one is supplied, so a present key here would mean the payload was not built by the contract.
  assert.deepEqual(f.sent[0], {
    action: 'send_qzone_msg',
    params: { content: 'hello world', ugc_right: 1 },
  }, '载荷必须精确等于 public publish 的平台请求形状');
  assert.deepEqual(Object.keys(f.sent[0].params).sort(), ['content', 'ugc_right'],
    'params 里不得出现 target_uins / tid / target_uin');
  assert.equal(Object.hasOwn(f.sent[0].params, 'target_uins'), false, '公开可见不得带收件人');
  assert.deepEqual(result.payload, f.sent[0], '返回里带出同一个载荷');
  // The payload IS the contract's output for the approved snapshot — not a hand-assembled copy.
  assert.deepEqual(f.sent[0], buildQzoneOnebotWriteRequest('publish', PUBLIC_INPUT));

  // ── the dispatch the write path froze: no visibility, no recipients, no target ──────
  assert.equal(captured.length, 1, 'transport 只被调用一次');
  const dispatch = captured[0];
  assert.equal(dispatch.action, 'publish', 'action 来自批准的业务动作');
  assert.equal(dispatch.kind, 'post', 'kind 由写路径按 ACTION_TO_KIND 决定 = 配额桶，不是业务动作');
  assert.equal(dispatch.target, null, 'publish 的 dispatch 没有 target（写路径冻结为 null）');
  assert.equal(dispatch.postId, null, 'publish 的 dispatch 没有 postId（平台分配）');
  assert.equal(dispatch.content, 'hello world');
  assert.equal(dispatch.source, SOURCE);
  // ★ THE POINT OF THE WHOLE DESIGN: the visibility is NOT on the dispatch.
  assert.equal(Object.hasOwn(dispatch, 'ugc_right'), false, '★ ugc_right 不进 dispatch');
  assert.equal(Object.hasOwn(dispatch, 'target_uins'), false, '★ target_uins 不进 dispatch');

  // ── durable B2 key: exactly one, our quadruple ─────────────────────────────────────
  assert.deepEqual(f.claimedKeys(), [JSON.stringify([ACCOUNT, SESSION, REQUEST, 'cp'])],
    'B2 键必须是 (account, session, request, call) 四元组');

  // ── quota: the POST bucket, and the 2-hour clock advanced ──────────────────────────
  assert.equal(f.store.read().ledger.used.post, 1, '配额必须恰好 +1，记在 post 桶');
  assert.equal(f.store.read().ledger.used.comment, 0, '不得记到 comment 桶');
  assert.equal(f.store.read().ledger.used.like, 0);
  assert.equal(f.store.read().ledger.reservations[dispatch.id], 'post', '预留记录归属 post 桶');
  assert.equal(f.store.read().lastPostAt, NOW, 'lastPostAt 必须推进到本次发送时刻');

  // ★ NO AUDIT ROW. `publish` reserves through `reserveOfflinePost` (non-audited), so nothing is
  // recorded — not an intent, not an outcome. This is asserted, not assumed.
  assert.deepEqual(f.store.read().audit, [],
    '★ 本模块走非审计预留：成功发送后 state.audit 仍然是空的（审计无法证明可见性，这里连行都没有）');
});

// ── 2. targeted visibility 16: recipients survive, each normalised by the builder ────
test('APD-2 正控 定向可见（ugc_right 16 + target_uins [111,"222"]）⇒ 载荷含两位收件人且归一为数字', async t => {
  const f = fixture(t);
  const result = await f.run({ input: TARGETED_INPUT });

  assert.equal(result.ok, true, `应当成功: ${JSON.stringify(result)}`);
  assert.equal(f.sent.length, 1, 'send 必须恰好被调用一次');
  assert.equal(result.quotaConsumed, true);

  assert.deepEqual(f.sent[0], {
    action: 'send_qzone_msg',
    params: { content: 'for you two', ugc_right: 16, target_uins: [111, 222] },
  }, '两位收件人一个不少、一个不多，字符串 identity 由 builder 归一');
  // Per-recipient normalisation, stated rather than implied by the deepEqual above.
  assert.equal(f.sent[0].params.target_uins.length, 2, '不得丢收件人');
  assert.deepEqual(f.sent[0].params.target_uins.map((v) => typeof v), ['number', 'number'],
    '每一位都归一为数字（builder 的 qq() 规则）');
  assert.deepEqual(f.sent[0].params.target_uins, [111, 222], '顺序保持，不去重不重排');
  assert.equal(f.sent[0].params.ugc_right, 16, '可见性原样传，不补默认、不改值');

  assert.equal(f.store.read().ledger.used.post, 1);
  assert.deepEqual(f.store.read().audit, [], '★ 同样不写审计：可见性与收件人都不进审计');
});

// ── 3. targeted visibility 128 ──────────────────────────────────────────────────────
test('APD-3 正控 定向可见（ugc_right 128）⇒ 载荷含两位收件人', async t => {
  const f = fixture(t);
  const result = await f.run({ input: TARGETED_128_INPUT });

  assert.equal(result.ok, true, `应当成功: ${JSON.stringify(result)}`);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0], {
    action: 'send_qzone_msg',
    params: { content: 'for you two as well', ugc_right: 128, target_uins: [111, 222] },
  }, '128 与 16 同一收件人规则');
  assert.equal(f.store.read().ledger.used.post, 1);
});

// ── 3b. friends-only 64: no recipients, and none invented ───────────────────────────
test('APD-3b 正控 64（好友可见，无收件人）⇒ 载荷只有 content + ugc_right', async t => {
  const f = fixture(t);
  const result = await f.run({ input: FRIENDS_INPUT });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0], {
    action: 'send_qzone_msg', params: { content: 'friends only', ugc_right: 64 },
  }, '没有收件人时不得补 target_uins');
  assert.equal(Object.hasOwn(f.sent[0].params, 'target_uins'), false);
});

// ── 4. THE NO-DEFAULT RULE: a publish without `ugc_right` never becomes public ──────
test('APD-4 不补默认可见性：缺 ugc_right ⇒ 受控拒绝，send 0、B2 0、配额 0、不问 host', async t => {
  const f = fixture(t);
  const result = await f.run({ input: { content: 'no visibility stated' } });

  assert.equal(result.ok, false, '缺可见性的 publish 必须被拒');
  assert.equal(result.stage, 'authorize', '拒绝发生在授权阶段：契约校验先于一切副作用');
  assert.equal(result.reason, 'not-authorized');
  // `prepare()` runs `validateQzoneMcpInput('publish', …)`, which routes through the platform
  // builder: `invalid visibility` throws instead of defaulting to public. So the host is never even
  // asked, and NO default visibility exists anywhere in this path.
  assert.equal(f.approve.calls, 0, '缺 ugc_right 的 input 连 host 都不该问');
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0, '不得占用 B2 键');
  assert.equal(f.store.read().ledger.used.post, 0, '不得消耗配额');
  assert.equal(f.store.read().lastPostAt, null, '不得推进 2 小时间隔');
  assert.deepEqual(f.store.read().audit, []);
});

test('APD-4b 可见性 4（不给收件人）同样通过，且与 1 一样不带 target_uins', async t => {
  const f = fixture(t);
  const result = await f.run({ input: { content: 'some visibility', ugc_right: 4 } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.sent[0].params, { content: 'some visibility', ugc_right: 4 });
});

// ── 5. RECIPIENTS ARE NEVER DROPPED, AND NEVER INVENTED ─────────────────────────────
//
// ⚠️ MEASURED DEVIATION FROM THE REQUESTED CASE, reported rather than papered over: the instruction
// expected `ugc_right:16` with no `target_uins` to reach the closure and be refused there as
// `payload-unbuildable`. It does NOT — and it cannot. `prepare()` runs
// `validateQzoneMcpInput('publish', …)`, which routes the input through the SAME
// `buildQzoneOnebotWriteRequest` the closure would call, so the builder's `invalid recipients` throw
// happens FIRST and becomes `prepare() -> null -> {stage:'authorize', reason:'not-authorized'}`.
//
// That is the strictly better outcome: the refusal lands BEFORE the reservation, so it costs no
// quota unit and starts no 2-hour cooldown. The closure's `payload-unbuildable` branch is therefore
// a DEFENSIVE branch that these inputs cannot reach (the approved snapshot is deep-frozen and was
// already built once during validation) — it exists so an unbuildable snapshot would still be a
// controlled refusal rather than an exception, not because a normal caller can trigger it. No test
// below claims to have exercised it.
test('APD-5 不丢收件人：ugc_right 16 但缺 target_uins ⇒ 契约在校验期先拒（非 payload-unbuildable），send 0、零消耗', async t => {
  const f = fixture(t);
  // `ugc_right: 16` REQUIRES recipients. The builder throws `invalid recipients`, and that throw is
  // what `validateQzoneMcpInput` sees, so `prepare()` refuses. The result is therefore the
  // AUTHORIZE-stage refusal — stronger than, and upstream of, the closure's `payload-unbuildable`:
  // nothing was reserved, so nothing was charged and no 2-hour cooldown was started.
  const result = await f.run({ input: { content: 'targeted with nobody', ugc_right: 16 } });

  assert.equal(result.ok, false, '定向可见缺收件人必须被拒');
  assert.equal(result.stage, 'authorize');
  assert.equal(result.reason, 'not-authorized');
  assert.equal(f.approve.calls, 0, '注定无法构造载荷的 input 不该问 host');
  assert.equal(f.sent.length, 0, '★ 不得带着"没有收件人"发出去');
  assert.equal(f.claimedKeys().length, 0);
  assert.equal(f.store.read().ledger.used.post, 0, '★ 零消耗：拒绝发生在预留之前');
  assert.equal(f.store.read().lastPostAt, null);
  assert.deepEqual(f.store.read().audit, []);
});

test('APD-5b 无收件人的可见性带 target_uins ⇒ 同样受控拒绝（不静默丢弃多余收件人）', async t => {
  const f = fixture(t);
  // The mirror image: `ugc_right: 1` with recipients is `unexpected recipients`. Dropping them
  // silently would publish to "everyone" a post the host approved for two people, so this is a
  // refusal, not a normalisation.
  const result = await f.run({ input: { content: 'public but addressed', ugc_right: 1, target_uins: [111] } });

  assert.equal(result.ok, false, '可见性与收件人矛盾必须被拒');
  assert.equal(result.stage, 'authorize');
  assert.equal(result.reason, 'not-authorized');
  assert.equal(f.sent.length, 0, '★ 不得把定向内容当成公开发出去');
  assert.equal(f.store.read().ledger.used.post, 0);
  assert.equal(f.approve.calls, 0);
});

// ── 6. host verdict: only strict `true` approves ────────────────────────────────────
test('APD-6 host 非严格 true ⇒ 受控拒绝，send 0、usedReadKeys 0、配额 0', async t => {
  const variants = [
    ['false', () => false],
    ['1', () => 1],
    ['"true"', () => 'true'],
    ['undefined', () => undefined],
    ['object', () => ({ approved: true })],
    ['throw', () => { throw new Error('host said no'); }],
    ['Promise.resolve(false)', () => Promise.resolve(false)],
    ['Promise.resolve(1)', () => Promise.resolve(1)],
  ];
  for (const [label, verdict] of variants) {
    const f = fixture(t, { approveOperation: verdict });
    const result = await f.run();
    assert.equal(result.ok, false, `${label}: 必须被拒`);
    assert.equal(result.stage, 'authorize', `${label}: 拒绝发生在授权阶段`);
    assert.equal(result.reason, 'not-authorized', `${label}: 理由`);
    assert.equal(f.sent.length, 0, `${label}: send 不得被调用`);
    assert.equal(f.claimedKeys().length, 0, `${label}: 不得占用 B2 键`);
    assert.equal(f.store.read().ledger.used.post, 0, `${label}: 不得消耗配额`);
    assert.equal(f.store.read().lastPostAt, null, `${label}: 不得动 2 小时间隔`);
  }
});

// ── 7. the durable B2 key was already taken ────────────────────────────────────────
test('APD-7 claim 失败（同四元组已被预占）⇒ send 0、B2 仍 1 条、如实报告配额已花', async t => {
  const f = fixture(t);
  // A real second claimer over the SAME store takes the key first — exactly what a crashed or a
  // concurrent dispatch leaves behind. It is not a fake: it writes the same durable collection.
  const pre = createReplayClaimer({ store: f.store, accountId: ACCOUNT }).claim({
    sessionId: SESSION, requestId: REQUEST, callId: 'cp', generation: 0,
  }, { now: NOW });
  assert.equal(pre.ok, true, '前提：预占成功');
  assert.equal(f.claimedKeys().length, 1, '前提：键已在库里');

  const result = await f.run();
  assert.equal(result.ok, false, '重复四元组必须被拒');
  assert.equal(result.stage, 'transport');
  assert.equal(result.outcome, 'not-sent', '必须在发送边界明确报 not-sent');
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'replay', '理由来自 B2 自己的词汇，不另造一套');
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 1, '不得多占一条键');
  // The reservation committed before the closure ran, so the post unit is spent and must be said.
  assert.equal(result.quotaConsumed, true, '预留已提交，必须如实报告');
  assert.equal(f.store.read().ledger.used.post, 1);
});

// ── 8. the claim's own store failure is `claim-failed`, NOT `unknown` ───────────────
test('APD-8 claim 的 store.update 抛错 ⇒ claim-failed / not-sent / sent:false，send 0（不重试）', async t => {
  const f = fixture(t, {
    replayStore: { read: () => ({}), update: () => { throw new Error('claim unavailable'); } },
  });
  const result = await f.run();

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'transport');
  assert.equal(result.outcome, 'not-sent', '必须是 not-sent，不能是 unknown（它并没有发出去）');
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'claim-failed', '必须走 claim-failed 分支');
  assert.equal(result.quotaConsumed, true, '预留已提交，必须如实报告');
  assert.equal(f.sent.length, 0, 'send 不得被调用，也不得重试');
  assert.equal(f.approve.calls, 1, 'host 只被问一次：没有重试');
  assert.equal(f.store.read().ledger.used.post, 1, '配额已花，不退');
});

// ── 9. a throwing send is `unknown` and is never retried ───────────────────────────
test('APD-9 send throw ⇒ outcome unknown，B2 仍在，send 只调 1 次，配额不退', async t => {
  const boom = new Error('socket reset');
  const f = fixture(t, { send: () => { throw boom; } });
  const result = await f.run();

  assert.equal(result.ok, true, '已经进入 transport 阶段');
  assert.equal(result.outcome, 'unknown', '抛出不能被读成"没发"');
  assert.equal(result.error, boom, '原始错误要带出来');
  assert.equal(result.sent, true, 'transport 被调用过');
  assert.equal(f.sent.length, 1, '不得重试');
  assert.equal(f.claimedKeys().length, 1, 'unknown 不撤销 B2 键');
  assert.equal(f.store.read().ledger.used.post, 1, 'unknown 不退配额');
  assert.equal(result.quotaConsumed, true);
});

// ── 10. every other action is refused BEFORE prepare ───────────────────────────────
test('APD-10 非 publish action ⇒ unsupported-action，send 0、B2 0、不问 host、零消耗', async t => {
  const f = fixture(t);
  const cases = [
    ['comment', { tid: 'post-1', target_uin: 9876543210, content: 'x' }],
    ['reply', { tid: 'post-1', target_uin: 9876543210, content: 'x', comment_id: 'cm-1', comment_uin: 7 }],
    ['like', { tid: 'post-1', target_uin: 9876543210 }],
    ['forward', { tid: 'post-1' }],
  ];
  for (const [action, input] of cases) {
    const result = await f.facade().execute({
      action,
      input,
      // A REAL consumption is passed on purpose: the refusal must come from the action check, not
      // from a missing authorization basis.
      consumption: f.consumptionFor(`c-${action}`),
      connectionEpoch: 0,
    });
    assert.equal(result.ok, false, `${action}: 必须被拒`);
    assert.equal(result.stage, 'authorize', `${action}: 拒绝发生在授权阶段`);
    assert.equal(result.reason, 'unsupported-action', `${action}: 受控拒绝`);
    assert.equal(result.action, action);
    assert.equal(typeof result.detail, 'string', `${action}: 必须给出原因`);
  }
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0, '不得占用 B2 键');
  assert.equal(f.approve.calls, 0, '不支持的 action 连 host 都不该问');
  assert.equal(f.store.read().ledger.used.post, 0, '不得消耗 post 配额');
  assert.equal(f.store.read().ledger.used.comment, 0);
  assert.equal(f.store.read().ledger.used.like, 0);
  assert.deepEqual(f.store.read().audit, [], '不得留下任何审计行');
});

test('APD-10b action 缺失 / 非字符串 ⇒ 同样是 unsupported-action，不是崩溃', async t => {
  const f = fixture(t);
  for (const action of [undefined, null, 42, 'Publish', '']) {
    const result = await f.facade().execute({
      action, input: PUBLIC_INPUT, consumption: f.consumptionFor('c-x'), connectionEpoch: 0,
    });
    assert.equal(result.ok, false, `${String(action)}: 必须被拒`);
    assert.equal(result.reason, 'unsupported-action', `${String(action)}: 受控拒绝`);
    assert.equal(result.action, typeof action === 'string' ? action : null, `${String(action)}: 拒绝里点名 action`);
  }
  assert.equal(f.sent.length, 0);
  assert.equal(f.approve.calls, 0);
});

// ── 11. the post bucket and the 2-hour interval ─────────────────────────────────────
test('APD-11 publish 计 post 桶并推进 2 小时间隔：2h 内第二次 publish ⇒ reserve 拒绝，send 仍 1 次', async t => {
  const f = fixture(t);
  const first = await f.run({ callId: 'cp-1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(f.store.read().ledger.used.post, 1, '第一次记 post 桶');
  assert.equal(f.store.read().lastPostAt, NOW, '第一次推进 lastPostAt');

  // One hour later — inside the 2-hour publish interval.
  f.live.now = NOW + 3600000;
  const second = await f.run({ callId: 'cp-2' });

  assert.equal(second.ok, false, '2 小时内第二次 publish 必须被拒');
  assert.equal(second.stage, 'reserve', '拒绝发生在预留阶段：未消耗、未发送');
  assert.equal(second.reason, 'interval', '理由来自策略层的 checkInterval');
  assert.equal(f.sent.length, 1, '★ send 仍只被调用一次');
  assert.equal(f.store.read().ledger.used.post, 1, '被拒的一次不得计费');
  assert.equal(f.claimedKeys().length, 1, '被拒的一次不得占用 B2 键');
  assert.equal(f.approve.calls, 2, '第二次也问了 host（间隔门在写路径里，晚于授权）');
  assert.equal(f.store.read().lastPostAt, NOW, '★ 被拒的一次不得推进间隔');
  assert.deepEqual(f.store.read().audit, [], '★ 两次都没有审计行');

  // Past the interval it is allowed again — the first refusal did not poison the path.
  f.live.now = NOW + TWO_HOURS;
  const third = await f.run({ callId: 'cp-3' });
  assert.equal(third.ok, true, JSON.stringify(third));
  assert.equal(f.sent.length, 2, '间隔过去后再次发送');
  assert.equal(f.store.read().ledger.used.post, 2, 'post 桶 +1');
  assert.equal(f.claimedKeys().length, 2, '两个不同的 callId ⇒ 两个 B2 键');
  assert.equal(f.sent[1].params.ugc_right, 1, '第二次的载荷仍然是批准的那份（公开、无收件人）');
});

// ── 11b. the reservation rules are the write path's, not this module's ─────────────
// NOTE ON WHAT THIS CASE ACTUALLY MEASURES: it does NOT prove that a repeated id is refused. The
// origin ledger retires a `callId`, so a caller cannot even present the same quadruple twice with a
// fresh consumption — the second run is a DIFFERENT callId and is therefore a different reservation
// id. What it shows is the honest, weaker fact: a second publish at the same instant is still
// stopped by the 2-hour interval, so the "same id twice" question never even arises at this layer.
// Reservation-id de-duplication is `reserveWrite`'s own rule, pinned in the write-path tests.
test('APD-11b 第二次 publish 在同一时刻仍被 2 小时间隔挡住（预留去重不是本模块的规则）', async t => {
  const f = fixture(t);
  const first = await f.run({ callId: 'cp-dup' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await f.run({ callId: 'cp-dup-2' });
  assert.equal(second.ok, false);
  assert.equal(second.stage, 'reserve');
  assert.equal(second.reason, 'interval', '第二次在同一时刻仍被 2 小时间隔挡住');
  assert.equal(f.sent.length, 1);
});

// ── 12. the dispatch/snapshot correspondence ban ────────────────────────────────────
test('APD-12 dispatch 被篡改 ⇒ send 0、B2 0、明确 not-sent（visibility 也不因此被"顺手补上"）', async t => {
  const tampered = [
    ['content', (d) => ({ ...d, content: 'something else' })],
    ['action', (d) => ({ ...d, action: 'comment' })],
    ['kind', (d) => ({ ...d, kind: 'comment' })],
    ['id', (d) => ({ ...d, id: 'some-other-id' })],
    ['source', (d) => ({ ...d, source: 'patrol' })],
    ['target', (d) => ({ ...d, target: '1122334455' })],
    ['postId', (d) => ({ ...d, postId: 'post-2' })],
    // A smuggled visibility on the dispatch must not be picked up: the payload comes from the
    // snapshot, so this is a mismatch (the dispatch is not the object we handed over)...
    ['ugc_right', (d) => ({ ...d, ugc_right: 1 })],
    // ...and a smuggled reply field means the dispatch is a different write.
    ['commentId', (d) => ({ ...d, commentId: 'cm-1' })],
  ];
  for (const [field, tamper] of tampered) {
    const f = fixture(t, { wrapDispatch: tamper });
    const result = await f.run();
    assert.equal(result.ok, false, `${field}: 不一致必须被拒`);
    assert.equal(result.stage, 'transport', `${field}: 拒绝发生在发送边界`);
    assert.equal(result.outcome, 'not-sent', `${field}: 必须明确报 not-sent`);
    assert.equal(result.sent, false, `${field}: 没有发出去`);
    assert.equal(typeof result.reason, 'string', `${field}: 拒绝必须点名`);
    assert.equal(f.sent.length, 0, `${field}: send 不得被调用`);
    assert.equal(f.claimedKeys().length, 0, `${field}: 比对在 claim 之前，不得占用 B2 键`);
    // The reservation committed before the closure ran — honest reporting, not a refund.
    assert.equal(result.quotaConsumed, true, `${field}: 预留已提交，必须如实报告`);
  }
});

test('APD-12b 批准在发送边界失效（input 被改）⇒ verify 拒绝，send 0、claim 0', async t => {
  // A mutable input mutated AFTER `prepare()` approved it but BEFORE the closure. `wrapDispatch`
  // runs inside the write path, i.e. strictly between the approval and the closure — the exact
  // window `verify()` exists to close.
  const mutable = { content: 'hello world', ugc_right: 1 };
  const f = fixture(t, {
    wrapDispatch: (dispatch) => {
      mutable.ugc_right = 16;
      mutable.target_uins = [999];
      return dispatch;
    },
  });
  const result = await f.run({ input: mutable });

  assert.equal(result.ok, false, '被改过的 input 不得继续发送');
  assert.equal(result.stage, 'transport');
  assert.equal(result.outcome, 'not-sent');
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'not-authorized', 'verify 不通过必须以授权失败报出');
  assert.equal(f.sent.length, 0, '★ 不得把可见性改后再发出去');
  assert.equal(f.claimedKeys().length, 0, 'verify 在 claim 之前，不得占用 B2 键');
});

// ── 13. construction-time refusals ─────────────────────────────────────────────────
test('APD-13 writePath 传实例而非工厂 ⇒ 构造期 TypeError（比对/verify/claim 不得被静默跳过）', async t => {
  const f = fixture(t);
  const instance = createOfflineWritePath({
    store: f.store, clock: () => NOW, transport: async () => ({ ok: true }),
  });
  assert.throws(
    () => createQzonePublishAuthorizer({
      authorizer: f.authorizer, writePath: instance, send: async () => ({ ok: true }), source: SOURCE,
    }),
    (error) => error instanceof TypeError && /factory/.test(error.message),
    '实例必须被拒：它已绑定 transport',
  );
  const noopSend = async () => ({ ok: true });
  const noopFactory = () => ({ write: async () => ({ ok: true }) });
  assert.throws(() => createQzonePublishAuthorizer({ writePath: noopFactory, send: noopSend, source: SOURCE }), TypeError);
  assert.throws(
    () => createQzonePublishAuthorizer({ authorizer: f.authorizer, writePath: noopFactory, source: SOURCE }),
    TypeError,
  );
  assert.throws(
    () => createQzonePublishAuthorizer({ authorizer: f.authorizer, writePath: noopFactory, send: noopSend }),
    TypeError,
  );
  assert.throws(
    () => createQzonePublishAuthorizer({ authorizer: f.authorizer, writePath: noopFactory, send: noopSend, source: '' }),
    TypeError,
    '空 source 必须被拒',
  );
});

// ── 14. paused: the write path's own gate, and the honest "reserved then not sent" ──
test('APD-14 一开始就 writePaused ⇒ 写路径拒发，send 0、B2 0、配额 0、零审计', async t => {
  const paused = baseState();
  paused.writePaused = true;
  const f = fixture(t, { state: paused });
  const result = await f.run();

  assert.equal(result.ok, false, '暂停时必须被拒');
  assert.equal(result.stage, 'reserve', '拒绝发生在预留阶段');
  assert.equal(result.reason, 'write_paused', '理由来自策略层');
  assert.equal(result.sent, false);
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0, '不得占用 B2 键');
  assert.equal(f.store.read().ledger.used.post, 0, '未预留，不得扣配额');
  assert.deepEqual(f.store.read().audit, []);
});

test('APD-14b post 日配额耗尽 ⇒ reserve 拒绝 limit，send 0、零消耗', async t => {
  const state = baseState();
  state.limits.post = 1;
  state.ledger.used.post = 1;      // the single allowed unit is already spent today
  const f = fixture(t, { state });
  const result = await f.run();

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'reserve');
  assert.equal(result.reason, 'limit', '理由来自 reserveWrite');
  assert.equal(f.sent.length, 0);
  assert.equal(f.claimedKeys().length, 0);
  assert.equal(f.store.read().lastPostAt, null, '被拒的一次不得推进间隔');
});

// ── 15. the store failure is not "not sent" ────────────────────────────────────────
test('APD-15 store.update 抛错 ⇒ 异常向外传播，send 0、B2 0', async t => {
  const dir = tempDir('broken');
  removeDir(t, dir);
  const real = openOfflineStore(path.join(dir, 'state.db'), baseState());
  t.after(() => { try { real.close(); } catch {} });
  assert.equal(initializeReplayState(real, { now: NOW }).ok, true);
  // The SUPPORTED way to fail a commit while keeping the send authority: spread the real handle.
  const broken = { ...real, update() { throw new Error('disk full'); } };
  assert.ok(broken.authority, '前提：包装器携带真实发送权威');

  const f = fixture(t, { writeStore: broken });
  await assert.rejects(f.run(), /disk full/, '存储故障必须抛给调用方，不能被压成"没发"');
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0, '未到 claim 边界');
});

// ── 16. WHY THE NOT_SENT VALUE IS NOT THE EVIDENCE FOR "NOT SENT" ─────────────────
//
// The header makes a claim about the write path's classifier, so it is PINNED here rather than left
// as prose. `{ok:false, notSent:true}` — the value the closure returns for every refusal — is read by
// `_classifyWriteTransportResult` as a CONTRADICTION (`ok:false` says "failed", `notSent:true` says
// "never left"), so the classifier answers `unknown`. That is the pessimistic direction and is fine
// for "did it go out?" — but it is NOT a "not-sent" label.
//
// Therefore the module never relies on it: after `write()` returns, a set `blocked` cell rewrites the
// result to `outcome:'not-sent'`. The cases above (APD-7, APD-8, APD-12, APD-12b) are the ones that
// prove the caller-visible label; this case proves the underlying fact they are built on, so a future
// classifier change cannot silently turn those into a weaker claim without failing here.
test('APD-16 分类器事实：{ok:false,notSent:true} 被判 unknown（故 not-sent 标签来自 blocked 单元，不是运输返回值）', async () => {
  const classify = _classifyForTests;
  assert.equal(classify({ ok: false, notSent: true }), 'unknown',
    '★ 矛盾声明按最悲观方向判 unknown：这正是不依赖它的理由');
  assert.equal(classify({ notSent: true }), 'not-sent', '只有 notSent 一个声明时才叫 not-sent');
  assert.equal(classify({ ok: true }), 'success');
});
