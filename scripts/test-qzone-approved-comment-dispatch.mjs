// The approved-comment dispatch, over a REAL temporary SQLite store and the REAL components it
// composes: the operation authorizer (B3 approval + B2 claim), the offline write path
// (gate -> reserve -> final check -> transport) and the OneBot write contract.
//
// Only what is genuinely external to this repository is a fixture:
//   · `approveOperation` — the host's verdict
//   · `isCurrent`        — the live-source probe
//   · `clock`            — pinned to NOW so intervals are deterministic
//   · `send`             — the platform call itself
//
// No fake consumption, no fake claimer, no fake store. From each test the numbers that matter are
// stated explicitly — how many times `send` ran, how many B2 keys exist, how many times the host was
// asked, and what the payload was — so a test that quietly stopped testing something fails on a
// number instead of sailing through.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState, createReplayClaimer } from '../src/core/qzone-replay-claim-offline.mjs';
import { createQzoneOriginLedger, isOriginLedgerConsumption } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneOperationAuthorizer } from '../src/core/qzone-operation-authorization-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { buildQzoneOnebotWriteRequest } from '../src/core/qzone-onebot-write-contract.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { createQzoneWriteAuthorizer } from '../src/core/qzone-approved-comment-dispatch-offline.mjs';

const NOW = Date.parse('2026-11-15T04:00:00Z');
const ACCOUNT = 123;
const SESSION = 's1';
const REQUEST = 'request-1';
const SOURCE = 'qq';
const INPUT = Object.freeze({ tid: 'post-1', target_uin: 9876543210, content: 'nice post' });
/** A like has NO body. `abstime` is deliberately absent: this module cannot carry it. */
const LIKE_INPUT = Object.freeze({ tid: 'post-1', target_uin: 9876543210 });
/** A reply: the parent comment plus ITS AUTHOR, which is the identity that needs evidence. */
const REPLY_INPUT = Object.freeze({
  tid: 'post-1', target_uin: 9876543210, content: 'replying to you',
  comment_id: 'cm-1', comment_uin: 7,
});
/** The same reply, additionally addressed to a person (the optional, validate-as-a-pair fields). */
const REPLY_WITH_TARGET_INPUT = Object.freeze({
  ...REPLY_INPUT, reply_uin: 42, reply_name: 'Bob',
});

const baseState = (now = NOW) => ({
  enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
  tools: { publish: true, comment: true, reply: true, like: true, read_posts: true },
  limits: { post: 10, comment: 25, like: 30 },
  ledger: { day: beijingDay(now), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null,
  lastCommentAt: null,
  commentTargets: [],
  likes: [],
  // `audit: []` — REQUIRED by the new contract. A reply now reserves through
  // `reserveAuditedOfflineInteraction`, which appends an `unknown` audit INTENT in the same
  // transaction as the quota unit. A state without an `audit` array throws `invalid audit state`, so
  // the fixture must carry the collection a real store has (every other qzone test fixture does).
  audit: [],
  // ⚠️ `commentEvidence` IS A TEST FIXTURE, NOT PRODUCTION EVIDENCE.
  //
  // **No producer of `state.commentEvidence` was found within the checked scope** (this repository's
  // `src/`): nothing in a read handler, an event adapter or any runtime wiring inserts rows here.
  // That is not a claim about every deployment, host or external writer. Seeding it below is the only
  // way to exercise the reply evidence gate end-to-end, and it proves exactly one thing — that the
  // GATE behaves as specified when a corroborating row is present. It does NOT prove that a real
  // reply can be sent: with no corroborating row the gate refuses, which is what a fresh state looks
  // like. Every seeded test says this out loud.
  //
  // An EMPTY (not absent) array is the default on purpose: it makes "no evidence ⇒ refusal" the
  // baseline, so a positive control has to add a row explicitly rather than inherit one.
  commentEvidence: [],
});

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qzone-acd-${label}-`));
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
 * write path. `writeStore` and `wrapDispatch` exist so the two failure modes that can only be
 * reached at the transport boundary (a broken store, a tampered dispatch) are still exercised
 * through the REAL write path instead of a hand-built stub.
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

  // ONE handle backs the authorizer, the write path and the reply evidence gate: one database, one
  // handle, no second view of state. The facade no longer takes a store at all — the reply evidence
  // gate moved into the reservation layer, inside the write path's own transaction — so there is no
  // longer any way to point the check at a different database than the reservation (see ACD-R7).
  const facade = () => createQzoneWriteAuthorizer({
    authorizer, writePath, send, source: SOURCE,
  });

  /** A real branded consumption. A fresh ledger per consumption: `consume()` retires a callId. */
  function consumptionFor(callId = 'c1') {
    const ledger = createQzoneOriginLedger({ sessionId: SESSION, epoch: 'e1' });
    ledger.registerBridgeRequest({ requestId: REQUEST, origin: 'qq-inbound' });
    assert.equal(ledger.observeStep({
      sessionId: SESSION, turn: 1, step: 1,
      messages: [{ role: 'user', source: { rpcId: REQUEST } }],
    }), true);
    assert.equal(ledger.observeToolCall({
      sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId } },
    }), true);
    const consumption = ledger.consume({ sessionId: SESSION, callId, turn: 1, step: 1 });
    assert.equal(isOriginLedgerConsumption(consumption), true, '前提：这是真实账本签发的 consumption');
    return consumption;
  }

  const claimedKeys = () => Object.keys(store.read().usedReadKeys ?? {});

  /**
   * Seed `state.commentEvidence` in the REAL store.
   *
   * ⚠️ FIXTURE. These rows are inserted by the test because no production code path inserts any.
   * Using them proves the evidence CHECK works; it does not make a production reply possible, and
   * nothing here may be described as "evidence that a real comment exists".
   */
  function seedEvidence(rows) {
    store.update((state) => ({ ...state, commentEvidence: rows }));
  }

  return {
    dir, store, live, approve, authorizer, sent, facade, consumptionFor, claimedKeys, seedEvidence,
    run(over = {}) {
      return facade().execute({
        action: 'comment',
        consumption: consumptionFor(over.callId ?? 'c1'),
        connectionEpoch: 0,
        input: INPUT,
        ...over,
      });
    },
    /**
     * The same run, for a like. Kept separate instead of `run({action:'like'})` so the default
     * `content` of the comment call can never leak into a like request.
     */
    runLike(over = {}) {
      return facade().execute({
        action: 'like',
        consumption: consumptionFor(over.callId ?? 'cl'),
        connectionEpoch: 0,
        input: LIKE_INPUT,
        ...over,
      });
    },
    /**
     * The same run, for a reply. The default `callId` is `cr`, so a reply test cannot share a B2
     * quadruple with the comment test's `c1` in the same fixture by accident.
     */
    runReply(over = {}) {
      return facade().execute({
        action: 'reply',
        consumption: consumptionFor(over.callId ?? 'cr'),
        connectionEpoch: 0,
        input: REPLY_INPUT,
        ...over,
      });
    },
  };
}

// ── 1. the happy path ───────────────────────────────────────────────────────────────
test('claim store failure after reservation never reports a send', async t => {
  const f = fixture(t, { replayStore: { read: () => ({}), update: () => { throw new Error('claim unavailable'); } } });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'not-sent');
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'claim-failed');
  assert.equal(result.quotaConsumed, true);
  assert.equal(f.sent.length, 0);
});

test('ACD-1 正常 comment：send 恰 1 次，载荷 = 批准 input 的构造结果，usedReadKeys 恰 1', async t => {
  const f = fixture(t);
  const result = await f.run();

  assert.equal(result.ok, true, `应当成功: ${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'success');
  assert.equal(result.sent, true);
  assert.equal(result.stage, 'transport');
  assert.equal(f.sent.length, 1, 'send 必须恰好被调用一次');
  assert.equal(f.approve.calls, 1, 'host 被问恰好一次');

  // The payload is the CONTRACT's output for the approved input, not a hand-assembled copy.
  const expected = buildQzoneOnebotWriteRequest('comment', INPUT);
  assert.deepEqual(f.sent[0], expected, '载荷必须与按批准 input 构造的一致');
  assert.equal(f.sent[0].action, 'comment_qzone');
  assert.deepEqual(f.sent[0].params, {
    tid: INPUT.tid, target_uin: INPUT.target_uin, content: INPUT.content,
  });
  assert.deepEqual(result.payload, expected, '返回里带出同一个载荷');

  const keys = f.claimedKeys();
  assert.equal(keys.length, 1, 'B2 键必须恰好 1 条');
  assert.deepEqual(keys, [JSON.stringify([ACCOUNT, SESSION, REQUEST, 'c1'])],
    '键必须正好是 (account, session, request, call) 四元组');

  // And the write really went through the reservation: it was not a bypass.
  assert.equal(f.store.read().ledger.used.comment, 1, '配额必须恰好 +1');
  assert.equal(result.quotaConsumed, true);
});

test('ACD-1b target_uin 为十进制字符串时映射到同一平台载荷', async t => {
  const f = fixture(t);
  const result = await f.run({ input: { tid: 'post-1', target_uin: '9876543210', content: 'nice post' } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].params, {
    tid: 'post-1', target_uin: 9876543210, content: 'nice post',
  }, '字符串 identity 由 builder 归一，载荷仍然可预测');
});

// ── 2. host refusal: only strict `true` approves ─────────────────────────────────────
test('ACD-2 host 非严格 true ⇒ 受控拒绝，send 0 次，usedReadKeys 0', async t => {
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
    assert.equal(f.store.read().ledger.used.comment, 0, `${label}: 不得消耗配额`);
    assert.equal(f.store.read().lastCommentAt, null, `${label}: 不得动 3 分钟间隔`);
  }
});

// ── 2b. the approval must still hold AT THE SEND BOUNDARY ──────────────────────────
test('ACD-2b 批准在发送边界失效（input 被改）⇒ verify 拒绝，send 0、claim 0', async t => {
  // A mutable input, mutated AFTER `prepare()` approved it but BEFORE the transport boundary.
  // `wrapDispatch` runs inside the write path, i.e. strictly between the approval and the closure,
  // which is exactly the window `verify()` exists to close.
  const mutable = { tid: 'post-1', target_uin: 9876543210, content: 'nice post' };
  const f = fixture(t, {
    wrapDispatch: (dispatch) => {
      mutable.content = 'swapped after approval';
      return dispatch;
    },
  });
  const result = await f.run({ input: mutable });

  assert.equal(result.ok, false, '被改过的 input 不得继续发送');
  assert.equal(result.stage, 'transport');
  assert.equal(result.outcome, 'not-sent');
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'not-authorized', 'verify 不通过必须以授权失败报出');
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0, 'verify 在 claim 之前，不得占用 B2 键');
});

// ── 3. the durable B2 key was already taken ─────────────────────────────────────────
test('ACD-3 同四元组已被 claim ⇒ 拒绝，send 0 次', async t => {
  const f = fixture(t);
  // A real second claimer over the SAME store takes the key first — exactly what a crashed or a
  // concurrent dispatch leaves behind. It is not a fake: it writes the same durable collection.
  const pre = createReplayClaimer({ store: f.store, accountId: ACCOUNT }).claim({
    sessionId: SESSION, requestId: REQUEST, callId: 'c1', generation: 0,
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
  // The reservation committed before the closure ran, so the unit is spent and must be reported.
  assert.equal(result.quotaConsumed, true, '预留已提交，必须如实报告');
  assert.equal(f.store.read().ledger.used.comment, 1);
});

// ── 4. a broken store is not "not sent" ─────────────────────────────────────────────
test('ACD-4 store throw ⇒ 异常向外传播，send 0 次', async t => {
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

// ── 5. the dispatch and the approved snapshot must describe the same write ──────────
test('ACD-5 dispatch 与批准快照不一致 ⇒ send 0 次、claim 0', async t => {
  const tampered = [
    ['content', (dispatch) => ({ ...dispatch, content: 'something else' })],
    ['postId', (dispatch) => ({ ...dispatch, postId: 'post-2' })],
    ['target', (dispatch) => ({ ...dispatch, target: '1122334455' })],
    ['action', (dispatch) => ({ ...dispatch, action: 'publish', kind: 'post' })],
    ['id', (dispatch) => ({ ...dispatch, id: 'some-other-id' })],
    ['source', (dispatch) => ({ ...dispatch, source: 'patrol' })],
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
  }
});

// ── 6. transport throw: unknown, never retried, never refunded ──────────────────────
test('ACD-6 send throw ⇒ outcome unknown，usedReadKeys 仍 1 条，send 只调 1 次', async t => {
  const boom = new Error('socket reset');
  const f = fixture(t, { send: () => { throw boom; } });
  const result = await f.run();

  assert.equal(result.ok, true, '已经进入 transport 阶段');
  assert.equal(result.outcome, 'unknown', '抛出不能被读成"没发"');
  assert.equal(result.error, boom, '原始错误要带出来');
  assert.equal(f.sent.length, 1, '不得重试');
  assert.equal(f.claimedKeys().length, 1, 'unknown 不撤销 B2 键');
  assert.equal(f.store.read().ledger.used.comment, 1, 'unknown 不退配额');
  assert.equal(result.quotaConsumed, true);
});

// ── 7. every other action is refused BEFORE prepare ─────────────────────────────────
// HISTORY, so this does not look like a test that was quietly weakened:
//   · `like` used to live here as `['like', 'abstime', …]` — it is SUPPORTED now (ACD-L*);
//   · `reply` used to live here too, on the grounds that the frozen dispatch has no carrier for
//     `comment_uin`/`reply_uin`/`reply_name`. It is SUPPORTED now as well, but ONLY together with
//     store-backed evidence (ACD-R*) — "supported" here means "reachable", never "sendable without
//     evidence". The refusal that REPLY still gets, when it has no evidence store, has its own
//     section (ACD-R0) with its own reason, because it is a different fact.
// Only `publish` and non-actions remain refused up front, each naming the field that has no carrier.
test('ACD-7 非 comment/reply/like（publish 及未知 action）⇒ 受控拒绝，send 0、usedReadKeys 0、不问 host', async t => {
  const f = fixture(t);
  const cases = [
    ['publish', 'ugc_right', { tid: 'post-1', target_uin: 9876543210, content: 'x', ugc_right: 1 }],
    ['forward', 'only comment', { tid: 'post-1', target_uin: 9876543210, content: 'x' }],
  ];
  for (const [action, field, input] of cases) {
    const result = await f.facade().execute({
      action,
      input,
      consumption: f.consumptionFor(`c-${action}`),
      connectionEpoch: 0,
    });
    assert.equal(result.ok, false, `${action}: 必须被拒`);
    assert.equal(result.stage, 'authorize', `${action}: 拒绝发生在授权阶段`);
    assert.equal(result.reason, 'unsupported-action', `${action}: 受控拒绝`);
    assert.equal(result.action, action);
    assert.equal(typeof result.detail, 'string', `${action}: 必须给出原因`);
    assert.ok(result.detail.includes(field), `${action}: detail 必须点名 ${field}`);
  }
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0, '不得占用 B2 键');
  assert.equal(f.approve.calls, 0, '不支持的 action 连 host 都不该问');
  assert.equal(f.store.read().ledger.used.comment, 0, '不得消耗配额');
  assert.equal(f.store.read().ledger.used.post, 0);
  assert.equal(f.store.read().ledger.used.like, 0);
});

// ── 8. a write path INSTANCE is a construction-time error ───────────────────────────
test('ACD-8 writePath 传实例而非工厂 ⇒ 构造期 TypeError', async t => {
  const f = fixture(t);
  const instance = createOfflineWritePath({
    store: f.store, clock: () => NOW, transport: async () => ({ ok: true }),
  });
  assert.throws(
    () => createQzoneWriteAuthorizer({
      authorizer: f.authorizer, writePath: instance, send: async () => ({ ok: true }), source: SOURCE,
    }),
    (error) => error instanceof TypeError && /factory/.test(error.message),
    '实例必须被拒：它已绑定 transport，比对/verify/claim 会被静默跳过',
  );
  // And the other three dependencies are refused just as loudly, so the check is not a special case.
  const noopSend = async () => ({ ok: true });
  const noopFactory = () => ({ write: async () => ({ ok: true }) });
  assert.throws(() => createQzoneWriteAuthorizer({ writePath: noopFactory, send: noopSend, source: SOURCE }), TypeError);
  assert.throws(
    () => createQzoneWriteAuthorizer({ authorizer: f.authorizer, writePath: noopFactory, source: SOURCE }),
    TypeError,
  );
  assert.throws(
    () => createQzoneWriteAuthorizer({ authorizer: f.authorizer, writePath: noopFactory, send: noopSend }),
    TypeError,
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════
// LIKE — the same machinery, a different body rule
// ══════════════════════════════════════════════════════════════════════════════════════
//
// A like is where the reuse has to be honest: the frozen approval, the write-path gate/reserve/
// final check, the verify, the single B2 claim and the `finally finish` are all the SAME code as
// the comment path — only the payload shape and the "no body" rule differ. Everything below runs
// against the real components (temp SQLite, real authorizer, real write path, real ledger), so a
// regression in any of those shows up here rather than in a stub.

// ── L1. the happy path ─────────────────────────────────────────────────────────────
test('ACD-L1 正常 like（不带 abstime）：send 恰 1 次，载荷 = {action:"like_qzone", params:{tid,target_uin}}', async t => {
  const captured = [];
  const f = fixture(t, {
    wrapDispatch: (dispatch) => { captured.push(dispatch); return dispatch; },
  });

  const result = await f.runLike();

  assert.equal(result.ok, true, `应当成功: ${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'success');
  assert.equal(result.sent, true);
  assert.equal(result.stage, 'transport');
  assert.equal(f.sent.length, 1, 'send 必须恰好被调用一次');
  assert.equal(f.approve.calls, 1, 'host 被问恰好一次');

  // ── the payload, EXACTLY ────────────────────────────────────────────────────────────
  // No `content` key at all: `FIELDS.like = {tid, target_uin, abstime}` and `copyFields` throws
  // `invalid field` on a body. If the dispatch's `content: null` were forwarded, this line would
  // never be reached — the transport would report `payload-unbuildable` instead.
  assert.deepEqual(f.sent[0], {
    action: 'like_qzone',
    params: { tid: 'post-1', target_uin: 9876543210 },
  }, '载荷必须精确等于 like 的平台请求形状');
  assert.deepEqual(Object.keys(f.sent[0].params).sort(), ['target_uin', 'tid'],
    'params 里不得出现 content / abstime');
  // The builder normalises the identity: MCP accepts a decimal string, the platform gets a number.
  assert.equal(typeof f.sent[0].params.target_uin, 'number');
  assert.equal(typeof f.sent[0].params.tid, 'string');
  assert.deepEqual(result.payload, f.sent[0], '返回里带出同一个载荷');

  // ── the dispatch the write path froze ──────────────────────────────────────────────
  assert.equal(captured.length, 1, 'transport 只被调用一次');
  const dispatch = captured[0];
  assert.equal(dispatch.action, 'like', 'action 来自批准的业务动作');
  assert.equal(dispatch.kind, 'like', 'kind 由写路径按 ACTION_TO_KIND 决定');
  assert.equal(Object.hasOwn(dispatch, 'commentId'), false, 'like 没有父评论');
  // `snapshotRequest` always writes the key: for a like it is `null` (no body), and this module
  // checked that `null` instead of forwarding it into `copyFields`.
  assert.equal(dispatch.content, null, '写路径冻结的 dispatch 里 like 没有正文');

  // ── the durable B2 key: exactly one, and it is our quadruple ───────────────────────
  const keys = f.claimedKeys();
  assert.equal(keys.length, 1, 'B2 键必须恰好 1 条');
  assert.deepEqual(keys, [JSON.stringify([ACCOUNT, SESSION, REQUEST, 'cl'])],
    '键必须正好是 (account, session, request, call) 四元组');

  // ── quota: the LIKE bucket, and only that one ─────────────────────────────────────
  assert.equal(f.store.read().ledger.used.like, 1, '配额必须恰好 +1，记在 like 桶');
  assert.equal(f.store.read().ledger.used.comment, 0, '不得记到 comment 桶');
  assert.equal(f.store.read().ledger.used.post, 0);
  assert.equal(f.store.read().ledger.reservations[dispatch.id], 'like', '预留记录归属 like 桶');
  assert.equal(result.quotaConsumed, true);

  // ── it really went through `reserveOfflineInteraction`: the same-post marker is written ──
  assert.deepEqual(f.store.read().likes, [{ author: '9876543210', id: 'post-1' }],
    'like 通过互动预留写入了同帖去重标记');
  assert.equal(f.store.read().lastCommentAt, null, 'like 不得动评论的 3 分钟间隔');
});

test('ACD-L1b like 重复发同一帖 ⇒ 写路径的同帖去重拒绝，send 仍只有 1 次', async t => {
  const f = fixture(t);
  const first = await f.runLike({ callId: 'cl-1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await f.runLike({ callId: 'cl-2' });

  assert.equal(second.ok, false, '同一帖第二次 like 必须被拒');
  assert.equal(second.stage, 'reserve', '拒绝发生在预留阶段（未消耗、未发送）');
  assert.equal(second.reason, 'duplicate_like', '理由来自写路径自己的词汇');
  assert.equal(f.sent.length, 1, 'send 仍只被调用一次');
  assert.equal(f.store.read().ledger.used.like, 1, '被拒的一次不得计费');
  assert.equal(f.claimedKeys().length, 1, '被拒的一次不得占用 B2 键');
});

// ── L2. `abstime` has no carrier: refuse, never drop ────────────────────────────────
test('ACD-L2 like 带 abstime ⇒ 受控拒绝，send 0、usedReadKeys 0、配额 0、不问 host', async t => {
  const f = fixture(t);
  // `0` is included on purpose: it is a LEGAL `abstime` (a falsy one), so a truthiness test would
  // silently DROP it and send a like at the wrong moment. A number is the normal case.
  for (const [label, abstime] of [['0', 0], ['1699999999', 1699999999]]) {
    const result = await f.facade().execute({
      action: 'like',
      input: { tid: 'post-1', target_uin: 9876543210, abstime },
      consumption: f.consumptionFor(`c-abstime-${label}`),
      connectionEpoch: 0,
    });

    assert.equal(result.ok, false, `${label}: 必须被拒`);
    assert.equal(result.stage, 'authorize', `${label}: 拒绝发生在授权阶段`);
    assert.equal(result.reason, 'unsupported-abstime', `${label}: 必须点名 abstime 没有承载位`);
    assert.equal(result.action, 'like');
    assert.equal(typeof result.detail, 'string');
    assert.ok(result.detail.includes('abstime'), `${label}: detail 必须点名 abstime`);
  }

  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0, '不得占用 B2 键');
  assert.equal(f.approve.calls, 0, '注定发不出去的 like 连 host 都不该问');
  assert.equal(f.store.read().ledger.used.like, 0, '不得消耗配额');
  assert.deepEqual(f.store.read().likes, [], '不得留下同帖去重标记');
  assert.equal(f.store.read().lastCommentAt, null, '不得动任何间隔');
});

// ── L3. pause: both layers, one like at a time ──────────────────────────────────────
test('ACD-L3a 一开始就 writePaused ⇒ 写路径拒发，send 0、B2 0、配额 0', async t => {
  const paused = baseState();
  paused.writePaused = true;
  const f = fixture(t, { state: paused });
  const result = await f.runLike();

  assert.equal(result.ok, false, '暂停时必须被拒');
  assert.equal(result.stage, 'reserve', '拒绝发生在预留阶段');
  assert.equal(result.reason, 'write_paused', '理由来自策略层');
  assert.equal(result.sent, false);
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0, '不得占用 B2 键');
  assert.equal(f.store.read().ledger.used.like, 0, '未预留，不得扣配额');
});

test('ACD-L3b 预留之后、终检之前被暂停 ⇒ paused-before-send，send 0、B2 0、配额已花', async t => {
  const f = fixture(t);
  // A pause that lands in the ONE window the write path re-checks: after the reservation committed
  // and before `finalAuthorisationCheck` reads committed state. The first `update` IS the
  // reservation, so flipping `writePaused` right after it is exactly that race.
  let updates = 0;
  const racing = {
    ...f.store,
    update(fn) {
      updates += 1;
      const returned = f.store.update(fn);
      if (updates === 1) f.store.update((state) => ({ ...state, writePaused: true }));
      return returned;
    },
  };
  assert.ok(racing.authority, '前提：spread 包装器携带真实发送权威');

  const authorizer = createQzoneOperationAuthorizer({
    store: f.store, accountId: ACCOUNT, sourceEpoch: 'e1', clock: () => NOW,
    approveOperation: () => true, isCurrent: () => true,
  });
  const writePath = (transport) => createOfflineWritePath({ store: racing, clock: () => NOW, transport });
  const facade = createQzoneWriteAuthorizer({ authorizer, writePath, send: async (p) => { f.sent.push(p); return { ok: true }; }, source: SOURCE });

  const result = await facade.execute({
    action: 'like', input: LIKE_INPUT, consumption: f.consumptionFor('cl-race'), connectionEpoch: 0,
  });

  assert.equal(result.ok, false, '终检拒绝必须报 not-sent，而不是成功');
  assert.equal(result.stage, 'transport');
  assert.equal(result.outcome, 'not-sent');
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'paused-before-send', '理由来自写路径的终检');
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0, '终检在 claim 之前，不得占用 B2 键');
  // The reservation committed before the final check, so the unit really is spent — say so.
  assert.equal(result.quotaConsumed, true, '预留已提交，必须如实报告');
  assert.equal(f.store.read().ledger.used.like, 1, 'like 桶已扣 1，且不退');
});

// ── L4. the claim is the last gate before the platform — on the like path too ───────
test('ACD-L4a like 同四元组已被 claim ⇒ replay 拒绝，send 0、B2 仍 1 条', async t => {
  const f = fixture(t);
  const pre = createReplayClaimer({ store: f.store, accountId: ACCOUNT }).claim({
    sessionId: SESSION, requestId: REQUEST, callId: 'cl', generation: 0,
  }, { now: NOW });
  assert.equal(pre.ok, true, '前提：预占成功');

  const result = await f.runLike();
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'transport');
  assert.equal(result.outcome, 'not-sent');
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'replay', '理由来自 B2 自己的词汇');
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 1, '不得多占一条键');
  assert.equal(result.quotaConsumed, true, '预留已提交，必须如实报告');
  assert.equal(f.store.read().ledger.used.like, 1);
});

test('ACD-L4b like：claim 的 store.update 抛错 ⇒ claim-failed / not-sent / sent:false，send 0', async t => {
  // Codex's fix, pinned on the LIKE path as well: the durable claim's commit status is unknown, but
  // `send` has not run — so this must be a controlled `claim-failed` refusal and NOT `unknown`
  // ("it may have gone out"), NOT a retry, and NOT an attempt to restore a possibly committed claim.
  const f = fixture(t, {
    replayStore: { read: () => ({}), update: () => { throw new Error('claim unavailable'); } },
  });
  const result = await f.runLike();

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'transport');
  assert.equal(result.outcome, 'not-sent', '必须是 not-sent，不能是 unknown');
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'claim-failed', '必须走 claim-failed 分支');
  assert.equal(result.quotaConsumed, true, 'like 的预留已提交，必须如实报告');
  assert.equal(f.sent.length, 0, 'send 不得被调用，也不得重试');
  assert.equal(f.store.read().ledger.used.like, 1, '配额已花，不退');
  // The B2 key is unreadable in this fixture (the store throws), so the only safe statement is that
  // no send happened and no attempt was made to repair the claim.
  assert.equal(f.approve.calls, 1, 'host 只被问一次：没有重试');
});

// ── L5. the dispatch/snapshot correspondence still bites on the like path ───────────
test('ACD-L5 like 的 dispatch 被篡改 ⇒ send 0、B2 0、明确 not-sent', async t => {
  const tampered = [
    ['action', (d) => ({ ...d, action: 'comment' })],
    ['kind', (d) => ({ ...d, kind: 'comment' })],
    ['postId', (d) => ({ ...d, postId: 'post-2' })],
    ['target', (d) => ({ ...d, target: '1122334455' })],
    ['content', (d) => ({ ...d, content: 'sneaked in' })],
    ['id', (d) => ({ ...d, id: 'some-other-id' })],
    ['source', (d) => ({ ...d, source: 'patrol' })],
  ];
  for (const [field, tamper] of tampered) {
    const f = fixture(t, { wrapDispatch: tamper });
    const result = await f.runLike();
    assert.equal(result.ok, false, `${field}: 不一致必须被拒`);
    assert.equal(result.stage, 'transport', `${field}: 拒绝发生在发送边界`);
    assert.equal(result.outcome, 'not-sent', `${field}: 必须明确报 not-sent`);
    assert.equal(result.sent, false, `${field}: 没有发出去`);
    assert.equal(typeof result.reason, 'string', `${field}: 拒绝必须点名`);
    assert.equal(f.sent.length, 0, `${field}: send 不得被调用`);
    assert.equal(f.claimedKeys().length, 0, `${field}: 比对在 claim 之前，不得占用 B2 键`);
  }
});

// ── L6. a like with a body never reaches the platform ──────────────────────────────
test('ACD-L6 like 带 content ⇒ 在批准前就被拒（MCP 契约不接受正文），send 0、配额 0', async t => {
  const f = fixture(t);
  const result = await f.facade().execute({
    action: 'like',
    input: { tid: 'post-1', target_uin: 9876543210, content: 'a body on a like' },
    consumption: f.consumptionFor('cl-body'),
    connectionEpoch: 0,
  });

  // TWO independent gates refuse this, and the FIRST one wins:
  //   · `validateQzoneMcpInput('like', …)` goes through `buildQzoneOnebotWriteRequest`, whose
  //     `copyFields` throws `invalid field` on `content` — so `prepare()` returns null and the
  //     whole operation is `not-authorized` before the host is even asked;
  //   · if it ever got past that, `snapshotRequest` has its own `unexpected-content` rule.
  // The observable here is the one the caller sees: no send, no reservation, no B2 key.
  assert.equal(result.ok, false, '带正文的 like 必须被拒');
  assert.equal(result.stage, 'authorize', '拒绝发生在授权阶段（契约先拒）');
  assert.equal(result.reason, 'not-authorized');
  assert.equal(f.approve.calls, 0, '被契约拒掉的 input 连 host 都不该问');
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0, '不得占用 B2 键');
  assert.equal(f.store.read().ledger.used.like, 0, '不得消耗配额');
  assert.deepEqual(f.store.read().likes, [], '不得留下同帖去重标记');
});

// ══════════════════════════════════════════════════════════════════════════════════════
// REPLY — the same machinery, plus the reservation layer's evidence gate
// ══════════════════════════════════════════════════════════════════════════════════════
//
// ⚠️ EVERY SEEDED ROW BELOW IS A TEST FIXTURE, NOT PRODUCTION EVIDENCE.
//
// **No producer of `state.commentEvidence` was found within the checked scope** (this repository's
// `src/`) — no read handler, no event adapter, no runtime wiring inserts one. That is not a claim
// about every deployment, host or external writer. These tests seed it by hand because that is the
// only way to exercise the gate; passing them proves the GATE behaves as specified, and proves
// NOTHING about production. With no corroborating row the gate refuses, and `ACD-R3` is that case.
// Do not cite these fixtures as evidence that a comment exists, that a reply was approved, or that
// reply is usable.
//
// ⚠️ THE CONTRACT THESE CASES NOW PIN (changed with the reservation-layer move)
// ---------------------------------------------------------------------------
//   · The evidence gate is `reserveAuditedOfflineInteraction`, inside the SAME `store.update` that
//     spends the `comment` unit. A missing/mismatched row therefore refuses at `stage:'reserve'`
//     with `quotaConsumed:false`, and `used.comment`, `lastCommentAt`, `commentTargets` and the B2
//     key are all UNCHANGED. It is NOT a transport-stage `not-sent` that has already paid.
//   · Refusal words are the RESERVATION layer's, not this module's: `missing_comment_evidence` /
//     `comment_evidence_mismatch` (underscores). The old hyphenated words and the closure-time
//     `evidence-unreadable` no longer exist, because this module no longer reads evidence.
//   · The facade takes NO `store`: there is no longer a second handle that could disagree with the
//     one the reservation uses.

/** The canonical, corroborating evidence row for `REPLY_INPUT` (fixture — see the banner above). */
const EVIDENCE_OK = Object.freeze({
  target: '9876543210', postId: 'post-1', commentId: 'cm-1',
  commentUin: 7, replyUin: null, replyName: null, at: NOW,
});

// ── R0. the facade needs NO store: the evidence gate is the reservation's job ───────
test('ACD-R0 reply 不再需要 facade 的 store：证据门在预留层，缺失证据在 reserve 阶段拒绝且零消耗', async t => {
  const f = fixture(t);
  // Built WITHOUT any store argument, which is now the NORMAL construction: this module cannot read
  // evidence at all any more, so it cannot read the WRONG one either.
  const bareFacade = createQzoneWriteAuthorizer({
    authorizer: f.authorizer, writePath: (transport) => createOfflineWritePath({
      store: f.store, clock: () => NOW, transport,
    }), send: async (payload) => { f.sent.push(payload); return { ok: true }; }, source: SOURCE,
  });
  const result = await bareFacade.execute({
    action: 'reply',
    input: REPLY_INPUT,
    consumption: f.consumptionFor('cr-nostore'),
    connectionEpoch: 0,
  });

  assert.equal(result.ok, false, '没有证据的 reply 仍必须被拒');
  assert.notEqual(result.reason, 'evidence-store-required',
    '★ 这个理由已被删除：缺 store 不再是拒绝理由，证据门在预留层');
  assert.equal(result.stage, 'reserve', '★ 拒绝发生在预留阶段（不再需要 facade 的 store）');
  assert.equal(result.reason, 'missing_comment_evidence', '拒因来自预留层同一套词汇');
  assert.equal(Object.hasOwn(result, 'quotaConsumed'), false, '★ 预留阶段拒绝没有 quotaConsumed 字段');
  assert.notEqual(result.quotaConsumed, true, '★ 零消耗');
  assert.equal(f.approve.calls, 1, 'host 会被问一次：证据门在 prepare 之后、预留之内');
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0, '不得占用 B2 键');
  assert.equal(f.store.read().ledger.used.comment, 0, '不得消耗配额');
  assert.equal(f.store.read().lastCommentAt, null, '不得推进 3 分钟间隔');
});

// ── R1. positive control: matched evidence ⇒ exactly one send, exact payload ────────
test('ACD-R1 正常 reply（evidence 匹配，fixture）⇒ send 恰 1 次，载荷 = builder 输出（含 comment_id/comment_uin）', async t => {
  // ⚠️ FIXTURE: EVIDENCE_OK is inserted by the test. No production code inserts it.
  const captured = [];
  const f = fixture(t, { wrapDispatch: (dispatch) => { captured.push(dispatch); return dispatch; } });
  f.seedEvidence([EVIDENCE_OK]);

  const result = await f.runReply();

  assert.equal(result.ok, true, `应当成功: ${JSON.stringify(result)}`);
  assert.equal(result.outcome, 'success');
  assert.equal(result.sent, true);
  assert.equal(f.sent.length, 1, 'send 必须恰好被调用一次');
  assert.equal(f.approve.calls, 1, 'host 被问恰好一次');

  // ── the payload, EXACTLY ────────────────────────────────────────────────────────────
  const expected = buildQzoneOnebotWriteRequest('reply', REPLY_INPUT);
  assert.deepEqual(f.sent[0], expected, '载荷必须与按批准 input 构造的一致');
  assert.equal(f.sent[0].action, 'comment_qzone', 'reply 走的是评论动作，不是 like/publish');
  assert.deepEqual(f.sent[0].params, {
    tid: 'post-1', target_uin: 9876543210, content: 'replying to you',
    comment_id: 'cm-1', comment_uin: 7,
  }, '五个必填字段一个不少、一个不多');
  assert.deepEqual(
    Object.keys(f.sent[0].params).sort(),
    ['comment_id', 'comment_uin', 'content', 'target_uin', 'tid'],
    'params 里不得出现 reply_uin / reply_name（批准快照里没有这两个字段）',
  );
  assert.deepEqual(result.payload, expected, '返回里带出同一个载荷');

  // ── the dispatch the write path froze: the reply's parent comment is on it ─────────
  assert.equal(captured.length, 1, 'transport 只被调用一次');
  assert.equal(captured[0].action, 'reply', 'action 来自批准的业务动作');
  assert.equal(captured[0].kind, 'comment', 'reply 记在 comment 配额桶');
  assert.equal(captured[0].commentId, 'cm-1', '父评论 id 由写路径冻结进 dispatch');

  // ── durable B2 key: exactly one, our quadruple, and the COMMENT bucket ─────────────
  assert.deepEqual(f.claimedKeys(), [JSON.stringify([ACCOUNT, SESSION, REQUEST, 'cr'])]);
  assert.equal(f.store.read().ledger.used.comment, 1, '配额 +1，记在 comment 桶');
  assert.equal(f.store.read().ledger.used.like, 0);
  assert.equal(f.store.read().ledger.reservations[captured[0].id], 'comment', '预留记录归属 comment 桶');
  assert.equal(result.quotaConsumed, true);
});

// ── R2. positive control: the optional reply target survives the whole chain ────────
test('ACD-R2 reply 带 reply_uin+reply_name（evidence 也带，fixture）⇒ 载荷含这两个字段', async t => {
  // ⚠️ FIXTURE: the row is inserted by the test; there is no production producer.
  const f = fixture(t);
  f.seedEvidence([{ ...EVIDENCE_OK, replyUin: 42, replyName: 'Bob' }]);

  const result = await f.runReply({ input: REPLY_WITH_TARGET_INPUT });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].params, {
    tid: 'post-1', target_uin: 9876543210, content: 'replying to you',
    comment_id: 'cm-1', comment_uin: 7, reply_uin: 42, reply_name: 'Bob',
  }, '批准到的 reply 目标必须原样送到平台');
  assert.equal(typeof f.sent[0].params.reply_uin, 'number', 'identity 由 builder 归一为数字');
});

// ── R3. no evidence at all ⇒ refusal, nothing sent, NOTHING SPENT ───────────────────
test('ACD-R3 reply 无 evidence（生产真实状态）⇒ reserve 阶段拒绝、零消耗、send 0、B2 0', async t => {
  const f = fixture(t);           // baseState seeds `commentEvidence: []` — the un-corroborated shape
  const result = await f.runReply();

  assert.equal(result.ok, false, '没有证据的 reply 必须被拒');
  assert.equal(result.stage, 'reserve', '★ 拒绝发生在预留阶段：证据门与额度在同一事务里');
  assert.equal(result.reason, 'missing_comment_evidence', '理由与预留路径同一套词汇（下划线）');
  // "Zero cost" is expressed in the write path's OWN vocabulary: a refusal decided before the
  // reservation carries NO `quotaConsumed` field at all (LZ-5 pins that absence as the pre-reserve
  // shape), and the state-level assertions below prove nothing moved. The old contract reported
  // `quotaConsumed:true` here, which is exactly the cost this change removes.
  assert.equal(Object.hasOwn(result, 'quotaConsumed'), false,
    '★ 预留阶段拒绝没有 quotaConsumed 字段（与 LZ-5 的预留前拒绝同一形态）');
  assert.notEqual(result.quotaConsumed, true, '★ 零消耗拒绝：一个单位都没花（旧契约此处是 true）');
  assert.equal(result.sent, false);
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0, '证据门在 claim 之前，不得占用 B2 键');
  // THE POINT OF THE MOVE, asserted rather than described: nothing was charged and no clock moved.
  assert.equal(f.store.read().ledger.used.comment, 0, '★ 配额未花（不是"已花且不退"）');
  assert.equal(f.store.read().lastCommentAt, null, '★ 3 分钟间隔未推进：被拒的请求不产生冷却');
  assert.deepEqual(f.store.read().commentTargets, [], '★ commentTargets 未变');
  assert.deepEqual(f.store.read().audit, [], '★ 同一事务里的意图审计也没有落盘（零预留 ⇒ 零审计）');
  assert.deepEqual(f.store.read().ledger.reservations, {}, '★ 没有为这次 reply 写任何预留记录');
});

test('ACD-R3b commentEvidence 整个缺失（不是空数组）⇒ 与空集合同样拒绝，零消耗', async t => {
  const state = baseState();
  delete state.commentEvidence;    // what a state written before the field existed looks like
  const f = fixture(t, { state });
  const result = await f.runReply();

  assert.equal(result.ok, false, '字段缺失不得被读成"没有限制"');
  assert.equal(result.stage, 'reserve', '★ 预留阶段拒绝');
  assert.equal(result.reason, 'missing_comment_evidence');
  assert.equal(Object.hasOwn(result, 'quotaConsumed'), false, '★ 预留阶段拒绝没有 quotaConsumed 字段');
  assert.notEqual(result.quotaConsumed, true, '★ 零消耗');
  assert.equal(f.sent.length, 0);
  assert.equal(f.claimedKeys().length, 0);
  assert.equal(f.store.read().ledger.used.comment, 0, '★ 配额未花');
  assert.equal(f.store.read().lastCommentAt, null, '★ 间隔未推进');
});

// ── R4. the evidence must agree about the parent comment's AUTHOR ───────────────────
test('ACD-R4 evidence 的 commentUin 与批准快照不符 ⇒ reserve 阶段拒绝、零消耗、send 0', async t => {
  // ⚠️ FIXTURE. The row matches target/post/comment but names a different author.
  const f = fixture(t);
  f.seedEvidence([{ ...EVIDENCE_OK, commentUin: 8 }]);

  const result = await f.runReply();

  assert.equal(result.ok, false, '父评论作者不符必须被拒');
  assert.equal(result.stage, 'reserve', '★ 预留阶段拒绝');
  assert.equal(result.reason, 'comment_evidence_mismatch', '★ 预留层词汇（下划线）');
  assert.equal(Object.hasOwn(result, 'quotaConsumed'), false, '★ 预留阶段拒绝没有 quotaConsumed 字段');
  assert.notEqual(result.quotaConsumed, true, '★ 零消耗');
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0, '不得占用 B2 键');
  assert.equal(f.store.read().ledger.used.comment, 0, '★ 配额未花');
  assert.equal(f.store.read().lastCommentAt, null, '★ 间隔未推进');
});

// ── R5. target / postId / commentId must match, one at a time ───────────────────────
test('ACD-R5 evidence 的 target/postId/commentId 任一不符 ⇒ 拒绝，零消耗、send 0', async t => {
  const variants = [
    ['target', { ...EVIDENCE_OK, target: '1122334455' }],
    ['postId', { ...EVIDENCE_OK, postId: 'post-2' }],
    ['commentId', { ...EVIDENCE_OK, commentId: 'cm-2' }],
  ];
  for (const [field, row] of variants) {
    // ⚠️ FIXTURE: one row is seeded per case, and it never matches on one of the three keys.
    const f = fixture(t);
    f.seedEvidence([row]);
    const result = await f.runReply();

    assert.equal(result.ok, false, `${field}: 不一致必须被拒`);
    assert.equal(result.stage, 'reserve', `${field}: ★ 预留阶段拒绝`);
    assert.equal(result.reason, 'missing_comment_evidence', `${field}: 没有任何一条证据指向这次 reply`);
    assert.equal(Object.hasOwn(result, 'quotaConsumed'), false, `${field}: ★ 没有 quotaConsumed 字段`);
    assert.notEqual(result.quotaConsumed, true, `${field}: ★ 零消耗`);
    assert.equal(result.sent, false, `${field}: 没有发出去`);
    assert.equal(f.sent.length, 0, `${field}: send 不得被调用`);
    assert.equal(f.claimedKeys().length, 0, `${field}: 不得占用 B2 键`);
    assert.equal(f.store.read().ledger.used.comment, 0, `${field}: ★ 配额未花`);
    assert.equal(f.store.read().lastCommentAt, null, `${field}: ★ 间隔未推进`);
  }
});

// ── R6. the reply-target pair must be agreed on BOTH sides ──────────────────────────
test('ACD-R6 批准带 reply_uin/reply_name 但 evidence 那两字段为 null ⇒ 拒绝，零消耗、send 0', async t => {
  // ⚠️ FIXTURE.
  const f = fixture(t);
  f.seedEvidence([{ ...EVIDENCE_OK, replyUin: null, replyName: null }]);

  const result = await f.runReply({ input: REPLY_WITH_TARGET_INPUT });

  assert.equal(result.ok, false, '批准了 reply 目标但证据不认，必须被拒');
  assert.equal(result.stage, 'reserve', '★ 预留阶段拒绝');
  assert.equal(result.reason, 'comment_evidence_mismatch');
  assert.equal(Object.hasOwn(result, 'quotaConsumed'), false, '★ 预留阶段拒绝没有 quotaConsumed 字段');
  assert.notEqual(result.quotaConsumed, true, '★ 零消耗');
  assert.equal(f.sent.length, 0);
  assert.equal(f.claimedKeys().length, 0);
  assert.equal(f.store.read().ledger.used.comment, 0, '★ 配额未花');
  assert.equal(f.store.read().lastCommentAt, null, '★ 间隔未推进');
});

test('ACD-R6b 批准没带 reply 目标但 evidence 带了 ⇒ 同样拒绝（成对规则双向生效）', async t => {
  // ⚠️ FIXTURE.
  const f = fixture(t);
  f.seedEvidence([{ ...EVIDENCE_OK, replyUin: 42, replyName: 'Bob' }]);

  const result = await f.runReply();   // REPLY_INPUT: no reply_uin / reply_name

  assert.equal(result.ok, false, '证据给了一次批准里没有的点名，必须被拒');
  assert.equal(result.stage, 'reserve', '★ 预留阶段拒绝');
  assert.equal(result.reason, 'comment_evidence_mismatch');
  assert.equal(Object.hasOwn(result, 'quotaConsumed'), false, '★ 预留阶段拒绝没有 quotaConsumed 字段');
  assert.notEqual(result.quotaConsumed, true, '★ 零消耗');
  assert.equal(f.sent.length, 0);
  assert.equal(f.claimedKeys().length, 0);
  assert.equal(f.store.read().ledger.used.comment, 0, '★ 配额未花');
});

test('ACD-R6c 两条 evidence 命中同一 comment ⇒ 歧义拒绝，不猜（零消耗、send 0）', async t => {
  // ⚠️ FIXTURE: two rows for the same (target, postId, commentId) that disagree about the author.
  const f = fixture(t);
  f.seedEvidence([{ ...EVIDENCE_OK }, { ...EVIDENCE_OK, commentUin: 8 }]);

  const result = await f.runReply();

  assert.equal(result.ok, false, '歧义不得被"取第一条"悄悄解决');
  assert.equal(result.stage, 'reserve', '★ 预留阶段拒绝');
  assert.equal(result.reason, 'comment_evidence_mismatch');
  assert.equal(Object.hasOwn(result, 'quotaConsumed'), false, '★ 预留阶段拒绝没有 quotaConsumed 字段');
  assert.notEqual(result.quotaConsumed, true, '★ 零消耗');
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0);
  assert.equal(f.store.read().lastCommentAt, null, '★ 间隔未推进');
});

test('ACD-R6d evidence 行缺 commentUin/replyUin/replyName 字段 ⇒ 拒绝，不当作匹配', async t => {
  // ⚠️ FIXTURE: the older `{target, postId, commentId}`-only shape. It corroborates nothing about
  // the parent's AUTHOR, which is the whole reason the gate exists.
  const f = fixture(t);
  f.seedEvidence([{ target: '9876543210', postId: 'post-1', commentId: 'cm-1' }]);

  const result = await f.runReply();

  assert.equal(result.ok, false, '缺 uin 字段的证据不能算匹配');
  assert.equal(result.stage, 'reserve', '★ 预留阶段拒绝');
  assert.equal(result.reason, 'comment_evidence_mismatch');
  assert.equal(Object.hasOwn(result, 'quotaConsumed'), false, '★ 预留阶段拒绝没有 quotaConsumed 字段');
  assert.notEqual(result.quotaConsumed, true, '★ 零消耗');
  assert.equal(f.sent.length, 0);
  assert.equal(f.claimedKeys().length, 0);
});

// ── R7. an UNREADABLE store is a store fault, not a controlled refusal ─────────────
test('ACD-R7 evidence 所在的 store 不可读 ⇒ 不再是授权的拒绝：写路径的 store 故障语义向外传播', async t => {
  // The old contract had a SEPARATE `evidence-unreadable` refusal here, produced by a `store.read()`
  // this module performed. That read is gone with the closure-time gate, so the case is re-stated
  // for the NEW contract: the only store this path touches is the reservation's, and a store whose
  // `read` throws must PROPAGATE (the write path refuses to describe an unreadable store as
  // "nothing happened"). Nothing is sent, nothing is claimed.
  const f = fixture(t);
  // The SUPPORTED way to fail a read while keeping the send authority: spread the real handle (the
  // same trick ACD-4 uses for a failing `update`). A hand-built object without `authority` is
  // refused at construction, which would make this case test the wrong thing.
  const unreadable = { ...f.store, read() { throw new Error('evidence db gone'); } };
  assert.ok(unreadable.authority, '前提：包装器携带真实发送权威');
  const facade = createQzoneWriteAuthorizer({
    authorizer: f.authorizer,
    writePath: (transport) => createOfflineWritePath({ store: unreadable, clock: () => NOW, transport }),
    send: async (payload) => { f.sent.push(payload); return { ok: true }; },
    source: SOURCE,
  });
  await assert.rejects(
    facade.execute({
      action: 'reply', input: REPLY_INPUT, consumption: f.consumptionFor('cr-unreadable'), connectionEpoch: 0,
    }),
    /evidence db gone/,
    '★ 存储故障必须抛给调用方，不得压成 not-sent（旧契约的 evidence-unreadable 已随闭包门一起删除）',
  );
  assert.equal(f.sent.length, 0, 'send 不得被调用');
  assert.equal(f.claimedKeys().length, 0, '不得占用 B2 键');
  assert.equal(f.store.read().ledger.used.comment, 0, '真实 store 上零消耗');
});

// ── R8. the durable claim is still the last gate, on the reply path too ────────────
test('ACD-R8 reply：claim 的 store.update 抛错 ⇒ claim-failed，send 0（Codex 分支在 reply 路径同样生效）', async t => {
  // ⚠️ FIXTURE for the evidence row; the store failure is real (a wrapper over the real handle).
  const f = fixture(t, {
    replayStore: { read: () => ({}), update: () => { throw new Error('claim unavailable'); } },
  });
  f.seedEvidence([EVIDENCE_OK]);

  const result = await f.runReply();

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'transport');
  assert.equal(result.outcome, 'not-sent', '必须是 not-sent，不能是 unknown');
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'claim-failed', '必须走 claim-failed 分支');
  assert.equal(f.sent.length, 0, 'send 不得被调用，也不得重试');
  assert.equal(result.quotaConsumed, true);
  assert.equal(f.store.read().ledger.used.comment, 1, '配额已花，不退');
  assert.equal(f.approve.calls, 1, 'host 只被问一次：没有重试');
});

// ── R9. a tampered dispatch is caught before the evidence read matters ─────────────
test('ACD-R9 reply 的 dispatch 被篡改 ⇒ send 0、B2 0、明确 not-sent', async t => {
  // ⚠️ FIXTURE for the evidence row, so the ONLY reason for refusal is the tampered dispatch.
  const tampered = [
    ['action', (d) => ({ ...d, action: 'comment' })],
    ['kind', (d) => ({ ...d, kind: 'like' })],
    ['commentId', (d) => ({ ...d, commentId: 'cm-2' })],
    ['content', (d) => ({ ...d, content: 'swapped' })],
    ['postId', (d) => ({ ...d, postId: 'post-2' })],
    ['target', (d) => ({ ...d, target: '1122334455' })],
    ['id', (d) => ({ ...d, id: 'some-other-id' })],
    ['source', (d) => ({ ...d, source: 'patrol' })],
  ];
  for (const [field, tamper] of tampered) {
    const f = fixture(t, { wrapDispatch: tamper });
    f.seedEvidence([EVIDENCE_OK]);
    const result = await f.runReply();
    assert.equal(result.ok, false, `${field}: 不一致必须被拒`);
    assert.equal(result.stage, 'transport', `${field}: 拒绝发生在发送边界`);
    assert.equal(result.outcome, 'not-sent', `${field}: 必须明确报 not-sent`);
    assert.equal(result.sent, false, `${field}: 没有发出去`);
    assert.equal(typeof result.reason, 'string', `${field}: 拒绝必须点名`);
    assert.equal(f.sent.length, 0, `${field}: send 不得被调用`);
    assert.equal(f.claimedKeys().length, 0, `${field}: 比对在 claim 之前，不得占用 B2 键`);
  }
});

// ── R10. `comment` and `reply` are NOT interchangeable on the same approval ─────────
test('ACD-R10 评论的批准不能被当成 reply 发送（反之亦然）：校验先于一切副作用', async t => {
  const f = fixture(t);
  // A comment snapshot has no `comment_id`, so the MCP reply contract refuses it in `prepare()`.
  const asReply = await f.facade().execute({
    action: 'reply', input: INPUT, consumption: f.consumptionFor('cr-wrong'), connectionEpoch: 0,
  });
  assert.equal(asReply.ok, false);
  assert.equal(asReply.reason, 'not-authorized', '缺 comment_id/comment_uin 的 reply 过不了契约');
  // ...and a reply snapshot cannot be sent as a comment either.
  const asComment = await f.facade().execute({
    action: 'comment', input: REPLY_INPUT, consumption: f.consumptionFor('cc-wrong'), connectionEpoch: 0,
  });
  assert.equal(asComment.ok, false);
  assert.equal(asComment.reason, 'not-authorized');
  assert.equal(f.sent.length, 0, '两种错配都不得发出任何东西');
  assert.equal(f.claimedKeys().length, 0);
  assert.equal(f.store.read().ledger.used.comment, 0, '不得消耗配额');
});
