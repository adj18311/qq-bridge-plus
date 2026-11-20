// Composed-chain regression for `src/core/qzone-b3-guarded-dispatch-offline.mjs`.
//
// The point of this file is that the chain is now a MODULE, not a fixture: every case below
// imports the single facade and drives it through a real temporary SQLite store plus a fake
// transport. Nothing here rebuilds the ordering by hand — that would put the property back
// inside a test file, which is exactly what Codex objected to in `test-qzone-b3-chain.mjs`.
//
// Coverage map (each assertion is meant to be able to fail on its own):
//   B3G-1   happy path: correlate -> claim -> dispatch, transport exactly once, claim on disk
//   B3G-2   unknown requestId            -> claim 0, transport 0
//   B3G-3   expired                      -> claim 0, transport 0
//   B3G-4   not yet valid                -> claim 0, transport 0
//   B3G-5   account mismatch             -> claim 0, transport 0
//   B3G-6   action not allowed           -> claim 0, transport 0
//   B3G-7   target out of scope          -> claim 0, transport 0
//   B3G-8   contract invalid             -> claim 0, transport 0
//   B3G-9   ownership/author mismatch    -> claim 0, transport 0
//   B3G-10  same key twice               -> transport 0 the second time
//   B3G-11  replay collection lost       -> transport 0
//   B3G-12  claim durable BEFORE dispatch (second SQLite connection sees it)
//   B3G-13  unknown outcome keeps the claim and is not retried
//   B3G-14  transport throws: claim kept, no retry
//   B3G-15  claim throws: propagates, never reported as sent
//   B3G-16  the selected reply candidate is NOT part of the claim key
//   B3G-17  contractValidator / ownership are mandatory injections
//   B3G-18  the identity handed to B2 is literally (session, request, call) — source guard
//
// Offline only: real temp SQLite file, fake transport, no QQ, no network, no production state.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createB3GuardedDispatch } from '../src/core/qzone-b3-guarded-dispatch-offline.mjs';
import { CORRELATION_REFUSAL, createFakeOwnershipMap, createCorrelationTable } from '../src/core/qzone-b3-correlation-offline.mjs';
import { REPLAY_REFUSAL } from '../src/core/qzone-replay-claim-offline.mjs';
import { QZONE_MCP_VALIDATORS } from '../src/core/qzone-mcp-contract.mjs';

const SELF = 9876543210;
const OTHER = 1122334455;
const AUTHOR = 5556667777;
const T0 = 1_800_000_000_000;
const TTL = 60_000;

/** The REAL business contract, not a hand-written shape check. */
const contractValidator = (action, input) => QZONE_MCP_VALIDATORS[action]?.(input) === true;

const defaultOwnership = () => createFakeOwnershipMap({
  t1: { ownerUin: SELF, commentIds: ['c1'], commentAuthors: { c1: String(AUTHOR) }, replyTargets: {} },
});

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-b3g-${label}-`));
  return {
    dir,
    dbPath: path.join(dir, 'state.db'),
    cleanup() {
      for (let i = 0; i < 20; i += 1) {
        try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
      }
    },
  };
}

const baseRecord = (over = {}) => ({
  requestId: 'req-1',
  accountId: SELF,
  sourceKind: 'group',
  sourceId: '1059972926',
  sourceMessageId: 'm-1',
  issuedAt: T0,
  ttlMs: TTL,
  allowedActions: ['read_posts', 'reply'],
  targetScope: 'self',
  ...over,
});

/**
 * Build one guarded facade over a REAL temp SQLite file.
 * The transport is a counter by default; `transport` replaces it.
 */
function world({ now = T0 + 1000, records = [baseRecord()], ownership, transport } = {}) {
  const t = tempDb('world');
  const store = openOfflineStore(t.dbPath, { enabled: false, reads: 0 });
  let clockNow = now;
  const transportCalls = [];
  const defaultTransport = async (action, input) => {
    transportCalls.push({ action, input });
    return { ok: true };
  };
  const facade = createB3GuardedDispatch({
    store,
    accountId: SELF,
    selfUin: SELF,
    clock: () => clockNow,
    ownership: ownership ?? defaultOwnership(),
    contractValidator,
    transport: transport ?? defaultTransport,
  });
  const init = facade.initialize({ now: T0 });
  if (init.ok !== true) throw new Error(`initialize failed: ${init.reason}`);
  for (const record of records) {
    const result = facade.record(record);
    if (result.ok !== true) throw new Error(`record failed: ${result.reason}`);
  }
  return {
    t, store, facade, transportCalls, dbPath: t.dbPath,
    setNow: (v) => { clockNow = v; },
    close() { try { store.close(); } catch {} t.cleanup(); },
  };
}

const readPosts = (over = {}) => ({
  requestId: 'req-1',
  action: 'read_posts',
  input: { target_uin: SELF },
  sessionId: 'sess-1',
  callId: 'call-1',
  ...over,
});

const replyCall = (over = {}) => ({
  requestId: 'req-1',
  action: 'reply',
  input: {
    tid: 't1',
    target_uin: SELF,
    content: 'hi',
    comment_id: 'c1',
    comment_uin: AUTHOR,
    reply_uin: 111111111,
    reply_name: 'alice',
  },
  sessionId: 'sess-1',
  callId: 'call-1',
  ...over,
});

// ── 1. happy path ──────────────────────────────────────────────────────────────────────
test('B3G-1 全链正常：三项按序通过，transport 恰好一次，claim 已落盘', async () => {
  const w = world();
  try {
    const out = await w.facade.dispatch(readPosts());
    assert.equal(out.ok, true, `expected ok, got ${JSON.stringify(out)}`);
    assert.equal(out.stage, 'transport');
    assert.equal(out.outcome, 'success');
    assert.equal(w.transportCalls.length, 1, 'transport 恰好一次');
    assert.deepEqual(w.transportCalls[0].input, { target_uin: SELF }, 'transport 收到的就是通过校验的 input');
    assert.equal(w.facade.claimSize(), 1, 'claim 已落盘（注意：claim ≠ 已派发，见模块注释）');
  } finally { w.close(); }
});

// ── 2. every correlation refusal: claim 0 and transport 0 ─────────────────────────────
test('B3G-2 未知 requestId：claim 0、transport 0', async () => {
  const w = world();
  try {
    const out = await w.facade.dispatch(readPosts({ requestId: 'never-issued' }));
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'correlate');
    assert.equal(out.reason, CORRELATION_REFUSAL.UNKNOWN_REQUEST);
    assert.equal(w.facade.claimSize(), 0, '前置拒绝不得写 claim（否则伪造请求能永久占键）');
    assert.equal(w.transportCalls.length, 0);
  } finally { w.close(); }
});

test('B3G-3 已过期：claim 0、transport 0', async () => {
  const w = world({ now: T0 + TTL });
  try {
    const out = await w.facade.dispatch(readPosts());
    assert.equal(out.stage, 'correlate');
    assert.equal(out.reason, CORRELATION_REFUSAL.EXPIRED);
    assert.equal(w.facade.claimSize(), 0);
    assert.equal(w.transportCalls.length, 0);
  } finally { w.close(); }
});

test('B3G-4 尚未生效：claim 0、transport 0', async () => {
  const w = world({ now: T0 - 1 });
  try {
    const out = await w.facade.dispatch(readPosts());
    assert.equal(out.stage, 'correlate');
    assert.equal(out.reason, CORRELATION_REFUSAL.NOT_YET_VALID);
    assert.equal(w.facade.claimSize(), 0);
    assert.equal(w.transportCalls.length, 0);
  } finally { w.close(); }
});

test('B3G-5 账号不符：claim 0、transport 0', async () => {
  const w = world();
  try {
    const out = await w.facade.dispatch(readPosts({ accountId: OTHER }));
    assert.equal(out.stage, 'correlate');
    assert.equal(out.reason, CORRELATION_REFUSAL.ACCOUNT_MISMATCH);
    assert.equal(w.facade.claimSize(), 0);
    assert.equal(w.transportCalls.length, 0);
  } finally { w.close(); }
});

test('B3G-6 action 不在授权集合：claim 0、transport 0', async () => {
  const w = world();
  try {
    const out = await w.facade.dispatch({
      requestId: 'req-1', action: 'like', input: { tid: 't1', target_uin: SELF },
      sessionId: 'sess-1', callId: 'call-1',
    });
    assert.equal(out.stage, 'correlate');
    assert.equal(out.reason, CORRELATION_REFUSAL.ACTION_NOT_ALLOWED);
    assert.equal(w.facade.claimSize(), 0);
    assert.equal(w.transportCalls.length, 0);
  } finally { w.close(); }
});

test('B3G-7 target 越界：claim 0、transport 0', async () => {
  const w = world();
  try {
    const out = await w.facade.dispatch(readPosts({ input: { target_uin: OTHER } }));
    assert.equal(out.stage, 'correlate');
    assert.equal(out.reason, CORRELATION_REFUSAL.TARGET_OUT_OF_SCOPE);
    assert.equal(w.facade.claimSize(), 0);
    assert.equal(w.transportCalls.length, 0);
  } finally { w.close(); }
});

test('B3G-8 业务契约非法：claim 0、transport 0（形状检查不是可选项）', async () => {
  const w = world();
  try {
    // The FAKE policy alone would accept this: target_uin is present, a real QQ, in scope.
    // Only the REAL contract rejects the extra field. If the facade let `contractValidator`
    // be omitted, this call would sail through — that is the gap this case pins.
    const out = await w.facade.dispatch(readPosts({ input: { target_uin: SELF, unexpected: true } }));
    assert.equal(out.stage, 'correlate');
    assert.equal(out.reason, CORRELATION_REFUSAL.CONTRACT_INVALID);
    assert.equal(w.facade.claimSize(), 0);
    assert.equal(w.transportCalls.length, 0);
  } finally { w.close(); }
});

test('B3G-9 作者不匹配 / 归属不匹配：claim 0、transport 0', async () => {
  const replySelections = [
    { replyUin: 111111111, replyName: 'alice' },
    { replyUin: 222222222, replyName: 'bob' },
  ];
  const w = world({ records: [baseRecord({ replySelections })] });
  try {
    // (a) comment_uin names somebody who did not write the comment.
    const authorMismatch = await w.facade.dispatch(replyCall({ input: { ...replyCall().input, comment_uin: 999999999 } }));
    assert.equal(authorMismatch.stage, 'correlate');
    assert.equal(authorMismatch.reason, CORRELATION_REFUSAL.AUTHOR_MISMATCH);

    // (b) target_uin is not the post's owner.
    const ownerMismatch = await w.facade.dispatch({
      requestId: 'req-1', action: 'read_posts', input: { target_uin: OTHER },
      sessionId: 'sess-1', callId: 'call-1',
    });
    assert.equal(ownerMismatch.stage, 'correlate');
    assert.ok(
      ownerMismatch.reason === CORRELATION_REFUSAL.TARGET_OUT_OF_SCOPE
      || ownerMismatch.reason === CORRELATION_REFUSAL.OWNERSHIP_MISMATCH,
      `unexpected reason ${ownerMismatch.reason}`,
    );

    assert.equal(w.facade.claimSize(), 0, '两种拒绝都不得写 claim');
    assert.equal(w.transportCalls.length, 0);
  } finally { w.close(); }
});

// ── 3. claim-stage refusals ──────────────────────────────────────────────────────────
test('B3G-10 同一 (request, call) 第二次：claim 拒、transport 不再调', async () => {
  const w = world();
  try {
    assert.equal((await w.facade.dispatch(readPosts())).ok, true);
    const second = await w.facade.dispatch(readPosts());
    assert.equal(second.ok, false);
    assert.equal(second.stage, 'claim');
    assert.equal(second.reason, REPLAY_REFUSAL.REPLAY);
    assert.equal(w.transportCalls.length, 1, '第二次不得触达 transport');
    assert.equal(w.facade.claimSize(), 1);
  } finally { w.close(); }
});

test('B3G-11 判重集合丢失：claim 拒、transport 0（fail-closed 贯穿全链）', async () => {
  const w = world();
  try {
    w.store.update((s) => { const next = { ...s }; delete next.usedReadKeys; return next; });
    const out = await w.facade.dispatch(readPosts());
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'claim');
    assert.equal(out.reason, REPLAY_REFUSAL.COLLECTION_LOST);
    assert.equal(w.transportCalls.length, 0);
  } finally { w.close(); }
});

// ── 4. durability strictly before dispatch ───────────────────────────────────────────
test('B3G-12 claim 持久化严格先于派发：transport 内用另一条 SQLite 连接读到 size===1', async () => {
  let observedDuringDispatch = null;
  let w;
  const transport = async () => {
    const other = openOfflineStore(w.dbPath, {});
    try {
      const raw = other.read();
      observedDuringDispatch = Object.keys(raw.usedReadKeys ?? {}).length;
    } finally { other.close(); }
    return { ok: true };
  };
  w = world({ transport });
  try {
    const out = await w.facade.dispatch(readPosts());
    assert.equal(out.ok, true);
    assert.equal(observedDuringDispatch, 1,
      '派发发生时另一条连接必须已能看到这个键 —— 否则 claim 没有先提交');
  } finally { w.close(); }
});

// ── 5. transport outcomes never re-send ──────────────────────────────────────────────
test('B3G-13 transport 返回 unknown：claim 保留、不重发', async () => {
  const w = world({ transport: async () => ({ unknown: true }) });
  try {
    const first = await w.facade.dispatch(readPosts());
    assert.equal(first.ok, true);
    assert.equal(first.outcome, 'unknown');
    assert.equal(w.facade.claimSize(), 1, 'unknown 保留认领');

    const retry = await w.facade.dispatch(readPosts());
    assert.equal(retry.stage, 'claim');
    assert.equal(retry.reason, REPLAY_REFUSAL.REPLAY, 'unknown 之后不得重发');
  } finally { w.close(); }
});

test('B3G-14 transport 抛错：claim 保留、不重试', async () => {
  const w = world({ transport: async () => { throw new Error('platform unreachable'); } });
  try {
    const first = await w.facade.dispatch(readPosts());
    assert.equal(first.ok, false);
    assert.equal(first.stage, 'transport');
    assert.equal(first.reason, 'transport-threw');
    assert.equal(first.error.message, 'platform unreachable');
    assert.equal(w.facade.claimSize(), 1, '抛错也保留认领（无法证明平台没动）');

    const retry = await w.facade.dispatch(readPosts());
    assert.equal(retry.stage, 'claim');
    assert.equal(retry.reason, REPLAY_REFUSAL.REPLAY);
  } finally { w.close(); }
});

test('B3G-15 claim 抛错必须向上抛出，绝不当成「已发送」或「未发送」', async () => {
  // The store is healthy for install + record, then starts failing only on the claim write.
  // That isolates the failure to the claim stage: correlation still passes, so the throw we
  // observe cannot be a correlation refusal in disguise.
  let failWrites = false;
  const t = tempDb('claimthrow');
  const real = openOfflineStore(t.dbPath, { enabled: false, reads: 0 });
  const store = {
    read: () => real.read(),
    update(fn) {
      if (failWrites) throw new Error('disk full');
      return real.update(fn);
    },
  };
  try {
    const transportCalls = [];
    const facade = createB3GuardedDispatch({
      store, accountId: SELF, selfUin: SELF, clock: () => T0 + 1000,
      ownership: defaultOwnership(), contractValidator,
      transport: async () => { transportCalls.push(1); return { ok: true }; },
    });
    assert.equal(facade.initialize({ now: T0 }).ok, true, '前提：安装成功');
    assert.equal(facade.record(baseRecord()).ok, true, '前提：关联表记录成功');

    failWrites = true;
    await assert.rejects(
      () => facade.dispatch(readPosts()),
      /disk full/,
      'claim 阶段的存储失败必须冒泡：调用方必须能区分「什么都没发生」与「无法记录是否发生」',
    );
    assert.equal(transportCalls.length, 0, 'claim 抛错时 transport 绝不能已被调用');
  } finally { try { real.close(); } catch {} t.cleanup(); }
});

// ── 6. the selection is not part of the claim key ────────────────────────────────────
//
// The two halves of this property must be proved SEPARATELY, otherwise the test proves the
// wrong thing:
//
//   (a) BOTH candidate selections must be individually acceptable to the correlation table.
//       If bob were simply not an offered candidate, the second call would be refused by
//       `authorize` and we would have proved "the table said no", not "B2 prevented a replay".
//       So each selection gets its own positive control, on its own callId.
//
//   (b) With the SAME (account, session, requestId, callId) and only the selection changed,
//       the second call must be refused at stage `claim` with reason `replay`. A refusal at
//       stage `correlate` is explicitly treated as a FAILURE of this case: it would mean the
//       call never reached the replay guard, so nothing about the claim key was demonstrated.
const SELECTIONS = Object.freeze([
  { replyUin: 111111111, replyName: 'alice' },
  { replyUin: 222222222, replyName: 'bob' },
]);

test('B3G-16a 正控：两个候选 selection 各自都能单独走通全链（否则下一条证明不了防重放）', async () => {
  for (const [index, selection] of SELECTIONS.entries()) {
    const w = world({ records: [baseRecord({ replySelections: [...SELECTIONS] })] });
    try {
      const out = await w.facade.dispatch(replyCall({
        callId: `call-cand-${index}`,
        input: { ...replyCall().input, reply_uin: selection.replyUin, reply_name: selection.replyName },
      }));
      assert.equal(out.ok, true,
        `候选 ${selection.replyName} 必须能通过关联表并派发；否则后面的 replay 断言会红在错误的原因上: ${JSON.stringify(out)}`);
      assert.equal(out.stage, 'transport');
      assert.equal(w.transportCalls.length, 1);
      assert.equal(w.facade.claimSize(), 1);
    } finally { w.close(); }
  }
});

test('B3G-16b 同一调用键只改 selection 第二次：必须在 claim 阶段判重，不得在 correlate 阶段被拒', async () => {
  const w = world({ records: [baseRecord({ replySelections: [...SELECTIONS] })] });
  try {
    const first = await w.facade.dispatch(replyCall({
      callId: 'call-same',
      input: { ...replyCall().input, reply_uin: SELECTIONS[0].replyUin, reply_name: SELECTIONS[0].replyName },
    }));
    assert.equal(first.ok, true, `第一次必须成功: ${JSON.stringify(first)}`);
    assert.equal(w.transportCalls.length, 1);
    assert.equal(w.facade.claimSize(), 1);

    const second = await w.facade.dispatch(replyCall({
      callId: 'call-same',
      input: { ...replyCall().input, reply_uin: SELECTIONS[1].replyUin, reply_name: SELECTIONS[1].replyName },
    }));

    // Guard FIRST: if this landed in `correlate`, the case has proved nothing about replay
    // prevention and must be reported as such rather than passing for the wrong reason.
    assert.notEqual(second.stage, 'correlate',
      `第二次必须是 B2 判重，而不是被关联表拒掉：${JSON.stringify(second)}`);
    assert.equal(second.ok, false, '只改 selection 不得让同一个调用再跑一次');
    assert.equal(second.stage, 'claim');
    assert.equal(second.reason, REPLAY_REFUSAL.REPLAY);
    assert.equal(w.transportCalls.length, 1, 'transport 只被调用一次');
    assert.equal(w.facade.claimSize(), 1, 'claim 键数仍为 1 —— selection 没有参与键构造');
  } finally { w.close(); }
});

// ── 7. mandatory injections ──────────────────────────────────────────────────────────
test('B3G-17 contractValidator 与 ownership 是必需注入项：缺失直接 TypeError', () => {
  const base = {
    store: { read: () => ({}), update: (fn) => fn({}) },
    accountId: SELF,
    selfUin: SELF,
    clock: () => T0,
    ownership: defaultOwnership(),
    contractValidator,
    transport: async () => ({ ok: true }),
  };
  const build = (over) => () => createB3GuardedDispatch({ ...base, ...over });

  assert.throws(build({ ownership: undefined }), /requires an ownership map/);
  assert.throws(build({ ownership: null }), /requires an ownership map/);
  assert.throws(build({ ownership: { has() {} } }), /requires an ownership map/);
  assert.throws(build({ contractValidator: undefined }), /requires a contractValidator/);
  assert.throws(build({ contractValidator: null }), /requires a contractValidator/);
  assert.throws(build({ contractValidator: 'nope' }), /requires a contractValidator/);

  // A fully supplied construction must still work — otherwise the assertions above could be
  // satisfied by an always-throwing factory.
  assert.doesNotThrow(build({}));
});

// ── 8. no bypass: the facade is the ONLY dispatch path ──────────────────────────────
test('B3G-19 无旁路：模块只导出一个函数，且门面不对外暴露 claimer / transport / dispatcher / table', () => {
  const module = fs.readFileSync(
    new URL('../src/core/qzone-b3-guarded-dispatch-offline.mjs', import.meta.url), 'utf8',
  );
  const exportNames = [...module.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm)]
    .map((m) => m[1]);
  assert.deepEqual(exportNames, ['createB3GuardedDispatch'],
    '唯一导出：多一个导出就多一个可能被直接调用而跳过某一段的入口');

  const t = tempDb('nobypass');
  const store = openOfflineStore(t.dbPath, { enabled: false, reads: 0 });
  try {
    const facade = createB3GuardedDispatch({
      store, accountId: SELF, selfUin: SELF, clock: () => T0 + 1000,
      ownership: defaultOwnership(), contractValidator, transport: async () => ({ ok: true }),
    });
    // The three stages must not be reachable as handle properties: exposing them would let a
    // caller run `claim` (or the transport) without going through the ordering.
    for (const forbidden of ['claimer', 'transport', 'dispatcher', 'table', 'store', 'correlate', 'claim', 'send']) {
      assert.equal(Object.hasOwn(facade, forbidden), false,
        `门面不得暴露 ${forbidden}：那会变成绕过固定顺序的旁路`);
    }
    // What IS exposed is only inspection / trusted-side recording / the one dispatch path.
    assert.deepEqual(Object.keys(facade).sort(), ['claimSize', 'dispatch', 'initialize', 'record', 'tableSize'],
      '门面的公开面必须正好是这五项');
  } finally { try { store.close(); } catch {} t.cleanup(); }
});

test('B3G-20 绕过门面直接调关联表 = 没有这层保护（claim 与 transport 都不会发生）', async () => {
  // This documents the boundary instead of pretending the composition is enforced globally:
  // the protection exists ONLY inside `dispatch()`. Anyone who imports the correlation table
  // directly can authorise a call and then do whatever they like — nothing here can stop that.
  const w = world({ records: [baseRecord({ replySelections: [...SELECTIONS] })] });
  try {
    const table = createCorrelationTable({
      selfUin: SELF, clock: () => T0 + 1000, ownership: defaultOwnership(), contractValidator,
    });
    assert.equal(table.record(baseRecord()).ok, true);
    const authorised = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } });
    assert.equal(authorised.ok, true, '前提：直接调关联表确实能通过授权');

    // Nothing behind the facade moved: no claim written, transport never called.
    assert.equal(w.facade.claimSize(), 0, '绕过门面不会产生 claim');
    assert.equal(w.transportCalls.length, 0, '绕过门面不会调用 transport');
  } finally { w.close(); }
});

// ── 9. source guard: the B2 identity carries no selection ────────────────────────────
test('B3G-18 交给 B2 的身份严格是 (session, request, call)：源码里键构造不含 selection', () => {
  const source = fs.readFileSync(
    new URL('../src/core/qzone-b3-guarded-dispatch-offline.mjs', import.meta.url), 'utf8',
  );
  assert.match(
    source,
    /identity:\s*\{\s*sessionId,\s*requestId,\s*callId,\s*generation\s*\}/,
    'identity 必须正好是这四个字段；多一个 selection 就会让「改选项」变成新键',
  );
  for (const forbidden of ['selectedReply', 'replySelections']) {
    assert.equal(source.includes(forbidden), false,
      `模块源码不得出现 ${forbidden}：一旦它参与键构造，改选项就会重开防重放窗口`);
  }
});
