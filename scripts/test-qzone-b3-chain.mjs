// B3 minimal combined chain: correlation table (B3) + persistent claim (B2) + fake transport.
//
// What this proves
//   · the ORDER actually holds in code, not just in prose:
//       correlate -> claim -> dispatch
//   · a failure at ANY pre-dispatch gate means claim is never taken and transport is never
//     called (so a forged request cannot poison the replay set)
//   · a claim failure means transport is never called
//   · the claim is durable BEFORE the transport runs
//   · unknown transport outcome keeps the claim and is never retried
//
// What this does NOT prove
//   · that the tool call really happened in DSH (B3-11/B3-12 stay open)
//   · that the requestId came from a real QQ event (issue() trusts its caller, B3-17)
//   · anything about model visibility or transcripts
//
// Storage is a REAL temporary SQLite file via the existing offline store; the transport is a
// counter. No QQ, no production state, no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import {
  REPLAY_REFUSAL,
  initializeReplayState,
  createReplayClaimer,
} from '../src/core/qzone-replay-claim-offline.mjs';
import { createReplayGuardedDispatcher } from '../src/core/qzone-replay-dispatch-offline.mjs';
import {
  CORRELATION_REFUSAL,
  createCorrelationTable,
} from '../src/core/qzone-b3-correlation-offline.mjs';

const SELF = 9876543210;
const OTHER = 1122334455;
const T0 = 1_800_000_000_000;

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-b3chain-${label}-`));
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

/**
 * Build the combined chain. The ONLY place that decides "may this execute" is `run()`, and it
 * does so in the fixed order: correlate -> claim -> transport.
 */
function buildChain({ now = T0 + 1000, record = {}, transportBehaviour = 'success', ownership } = {}) {
  const t = tempDb('chain');
  const store = openOfflineStore(t.dbPath, { enabled: false, reads: 0 });
  initializeReplayState(store, { now: T0 });

  let clockNow = now;
  const table = createCorrelationTable({ selfUin: SELF, clock: () => clockNow, ownership });
  table.record({
    requestId: 'req-1',
    accountId: SELF,
    sourceKind: 'group',
    sourceId: '1059972926',
    sourceMessageId: 'm-1',
    issuedAt: T0,
    ttlMs: 60_000,
    allowedActions: ['read_posts', 'publish', 'reply'],
    targetScope: 'self',
    ...record,
  });

  const claimer = createReplayClaimer({ store, accountId: SELF });
  const transportCalls = [];
  const transport = async (action, input) => {
    transportCalls.push({ action, input });
    if (transportBehaviour === 'throw') throw new Error('platform unreachable');
    if (transportBehaviour === 'unknown') return { unknown: true };
    return { ok: true };
  };
  const dispatcher = createReplayGuardedDispatcher({ claimer, transport, clock: () => clockNow });

  /** The chain. Order is the whole point of this test file. */
  async function run({ requestId, accountId = SELF, action, input, callId = 'call-1' }) {
    // 1. correlation (B3) — MUST happen before any claim, so a forged request cannot occupy a
    //    replay key and deny service to the legitimate one.
    const correlation = table.authorize({ requestId, accountId, action, input });
    if (!correlation.ok) {
      return { ok: false, stage: 'correlate', reason: correlation.reason, transportCalls: transportCalls.length, claimSize: claimer.size() };
    }
    // 2. claim (B2) + 3. dispatch, via the already-reviewed wrapper.
    const out = await dispatcher.dispatch({
      identity: { sessionId: 'sess-1', requestId, callId },
      action,
      input,
    });
    return { ...out, transportCalls: transportCalls.length, claimSize: claimer.size() };
  }

  return {
    t, store, table, claimer, dispatcher, transportCalls, run,
    setNow: (v) => { clockNow = v; },
    close: () => { try { store.close(); } catch {} t.cleanup(); },
  };
}

const readPosts = (over = {}) => ({ action: 'read_posts', input: { target_uin: SELF }, requestId: 'req-1', ...over });

// ── 1. happy path: all three stages in order ────────────────────────────────────────
test('B3X-1 全链正常：correlate → claim → dispatch，transport 恰好一次', async () => {
  const c = buildChain();
  try {
    const out = await c.run(readPosts());
    assert.equal(out.ok, true);
    assert.equal(out.outcome, 'success');
    assert.equal(c.transportCalls.length, 1, 'transport 恰好一次');
    assert.equal(c.claimer.size(), 1, 'claim 已落盘');
    // durable across reopen
    c.store.close();
    const reopened = openOfflineStore(c.t.dbPath, {});
    assert.equal(createReplayClaimer({ store: reopened, accountId: SELF }).size(), 1);
    reopened.close();
  } finally { c.close(); }
});

// ── 2. pre-dispatch refusals must not take a claim and must not dispatch ───────────
test('B3X-2 未知 requestId：claim 不写、transport 不调（伪造不能污染判重集）', async () => {
  const c = buildChain();
  try {
    const out = await c.run(readPosts({ requestId: 'never-issued' }));
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'correlate');
    assert.equal(out.reason, CORRELATION_REFUSAL.UNKNOWN_REQUEST);
    assert.equal(c.claimer.size(), 0, '前置拒绝时 claim 必须为 0 —— 否则伪造请求能永久占键');
    assert.equal(c.transportCalls.length, 0);
  } finally { c.close(); }
});

test('B3X-3 action 不在集合：claim 不写、transport 不调', async () => {
  const c = buildChain();
  try {
    const out = await c.run({ requestId: 'req-1', action: 'comment', input: { tid: 't', target_uin: SELF, content: 'x' } });
    assert.equal(out.reason, CORRELATION_REFUSAL.ACTION_NOT_ALLOWED);
    assert.equal(c.claimer.size(), 0);
    assert.equal(c.transportCalls.length, 0);
  } finally { c.close(); }
});

test('B3X-4 越范围目标：claim 不写、transport 不调', async () => {
  const c = buildChain();
  try {
    const out = await c.run({ requestId: 'req-1', action: 'read_posts', input: { target_uin: OTHER } });
    assert.equal(out.reason, CORRELATION_REFUSAL.TARGET_OUT_OF_SCOPE);
    assert.equal(c.claimer.size(), 0);
    assert.equal(c.transportCalls.length, 0);
  } finally { c.close(); }
});

test('B3X-5 未生效请求：claim 不写、transport 不调', async () => {
  const c = buildChain({ now: T0 - 500 });   // clock before issuedAt
  try {
    const out = await c.run(readPosts());
    assert.equal(out.reason, CORRELATION_REFUSAL.NOT_YET_VALID);
    assert.equal(c.claimer.size(), 0);
    assert.equal(c.transportCalls.length, 0);
  } finally { c.close(); }
});

test('B3X-6 过期请求：claim 不写、transport 不调', async () => {
  const c = buildChain({ now: T0 + 60_000 });
  try {
    const out = await c.run(readPosts());
    assert.equal(out.reason, CORRELATION_REFUSAL.EXPIRED);
    assert.equal(c.claimer.size(), 0);
    assert.equal(c.transportCalls.length, 0);
  } finally { c.close(); }
});

// ── 3. claim-stage failure must not dispatch ────────────────────────────────────────
test('B3X-7 同一 (requestId, callId) 第二次：claim 拒、transport 不再调', async () => {
  const c = buildChain();
  try {
    assert.equal((await c.run(readPosts())).ok, true);
    const second = await c.run(readPosts());   // same callId
    assert.equal(second.ok, false);
    assert.equal(second.stage, 'claim');
    assert.equal(second.reason, REPLAY_REFUSAL.REPLAY);
    assert.equal(c.transportCalls.length, 1, '第二次不得触达 transport');
    assert.equal(c.claimer.size(), 1);
  } finally { c.close(); }
});

test('B3X-8 claim 集合丢失：拒绝且不派发（fail-closed 贯穿全链）', async () => {
  const c = buildChain();
  try {
    // Damage the replay collection while leaving the install residue.
    c.store.update((s) => { const n = { ...s }; delete n.usedReadKeys; return n; });
    const out = await c.run(readPosts());
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'claim');
    assert.equal(out.reason, REPLAY_REFUSAL.COLLECTION_LOST);
    assert.equal(c.transportCalls.length, 0);
  } finally { c.close(); }
});

// ── 4. persistence strictly before dispatch ────────────────────────────────────────
test('B3X-9 claim 持久化严格先于派发：transport 被调用时键已可被另一连接看到', async () => {
  const t = tempDb('ordering');
  let store;
  try {
    store = openOfflineStore(t.dbPath, {});
    initializeReplayState(store, { now: T0 });
    const claimer = createReplayClaimer({ store, accountId: SELF });

    const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000 });
    table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
      sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['read_posts'], targetScope: 'self' });

    let observedDuringDispatch = null;
    const transport = async () => {
      // A SECOND connection must already see the key here, otherwise the claim was not durable
      // before the platform call.
      const other = openOfflineStore(t.dbPath, {});
      observedDuringDispatch = createReplayClaimer({ store: other, accountId: SELF }).size();
      other.close();
      return { ok: true };
    };
    const dispatcher = createReplayGuardedDispatcher({ claimer, transport, clock: () => T0 + 1000 });

    const correlation = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } });
    assert.equal(correlation.ok, true);
    const out = await dispatcher.dispatch({ identity: { sessionId: 's', requestId: 'req-1', callId: 'c1' }, action: 'read_posts', input: { target_uin: SELF } });

    assert.equal(out.ok, true);
    assert.equal(observedDuringDispatch, 1, '派发发生时，另一连接必须已能看到这个键（即已提交）');
    store.close();
  } finally { try { store?.close(); } catch {} t.cleanup(); }
});

// ── 5. unknown outcome keeps the claim and is not retried ─────────────────────────
test('B3X-10 transport 未知：claim 保留、不自动重发', async () => {
  const c = buildChain({ transportBehaviour: 'unknown' });
  try {
    const first = await c.run(readPosts());
    assert.equal(first.ok, true);
    assert.equal(first.outcome, 'unknown');
    assert.equal(c.claimer.size(), 1, 'unknown 保留认领');

    const retry = await c.run(readPosts());
    assert.equal(retry.ok, false);
    assert.equal(retry.reason, REPLAY_REFUSAL.REPLAY);
    assert.equal(c.transportCalls.length, 1, 'unknown 之后不得重发');
  } finally { c.close(); }
});

test('B3X-11 transport 抛错：claim 保留、不重试', async () => {
  const c = buildChain({ transportBehaviour: 'throw' });
  try {
    const first = await c.run(readPosts());
    assert.equal(first.ok, false);
    assert.equal(first.stage, 'transport');
    assert.equal(first.reason, 'transport-threw');
    assert.equal(c.transportCalls.length, 1);

    const retry = await c.run(readPosts());
    assert.equal(retry.reason, REPLAY_REFUSAL.REPLAY);
    assert.equal(c.transportCalls.length, 1);
    assert.equal(c.claimer.size(), 1);
  } finally { c.close(); }
});

// ── 6. the gap this chain does NOT close ───────────────────────────────────────────
test('B3X-12 【边界】换 callId 的同一授权仍可再派发一次 —— 这是 B2 在挡，不是 B3', async () => {
  const c = buildChain();
  try {
    const first = await c.run(readPosts({ callId: 'call-a' }));
    assert.equal(first.ok, true);
    // Same requestId, within-scope action and target, but a NEW callId. The correlation table
    // has no way to know whether this second call really happened in DSH.
    const second = await c.run(readPosts({ callId: 'call-b' }));
    assert.equal(second.ok, true, '关联表挡不住换 callId —— 只有 B2 的键能限制次数');
    assert.equal(c.transportCalls.length, 2);
    assert.equal(c.claimer.size(), 2, '两个不同的 (request, call) 各占一个键');
  } finally { c.close(); }
});
