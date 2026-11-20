// S-1 / S-2 / S-3: what happens to an ALREADY-TAKEN claim when the authorisation layer
// expires a proof, revokes everything, or moves to a new generation.
//
// The shared rule under test: **a claim, once written, is never reclaimed by a later event.**
// Revocation and expiry remove the right to make a NEW call; they do not — and must not —
// rewrite the record of calls that already happened.
//
// WHY THIS FILE IS ALMOST ENTIRELY ASSERTIONS AND (ALMOST) NO PRODUCTION CODE
// ---------------------------------------------------------------------------
// The facade runs `correlate -> claim -> transport` and B2 has NO deletion path at all:
// nothing in `qzone-replay-claim-offline.mjs` removes a key, and nothing in the facade touches
// the key collection. So "the claim survives expiry / revocation / generation change" is not
// something the code does — it is something the code CANNOT do. The risk is a future reader
// adding "cleanup on refusal" and silently reopening the replay window. The only correct
// response is to pin the current behaviour with tests, not to add defensive code that
// duplicates an invariant the design already gives for free.
//
// TWO LAYERS, NAMED HONESTLY
// --------------------------
// There are two separate gates in this sample and the report must not blur them:
//
//   · the PROOF layer (`qzone-origin-proof-offline.mjs`): request-level capability with a TTL
//     and a `revokeAll()` generation. It is NOT imported by the facade.
//   · the facade's own `correlate` stage: the B3 correlation table (`expiresAt`, allowed
//     actions, target scope, contract shape, ownership).
//
// So the composed order exercised here is:
//
//     proof.verify -> facade.correlate -> facade.claim -> transport
//
// The claim-retention assertions are made on the facade's `claimSize()` and on a real second
// dispatch through the facade, so they are about B2, not about the proof layer's bookkeeping.
//
// Offline only: real temp SQLite, real proof module, fake transport. No QQ, no network.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createB3GuardedDispatch } from '../src/core/qzone-b3-guarded-dispatch-offline.mjs';
import { CORRELATION_REFUSAL, createFakeOwnershipMap } from '../src/core/qzone-b3-correlation-offline.mjs';
import { REPLAY_REFUSAL } from '../src/core/qzone-replay-claim-offline.mjs';
import { QZONE_MCP_VALIDATORS } from '../src/core/qzone-mcp-contract.mjs';
import {
  createIssuanceRegistry,
  createProofIssuer,
  createProofVerifier,
} from '../src/core/qzone-origin-proof-offline.mjs';

const SELF = 9876543210;
const T0 = 1_800_000_000_000;
const TTL = 60_000;
const SECRET = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'); // 32 bytes

const contractValidator = (action, input) => QZONE_MCP_VALIDATORS[action]?.(input) === true;
const ownership = () => createFakeOwnershipMap({});

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qzone-rev-${label}-`));
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

/** One trusted-side proof generation: registry + issuer + verifier over a shared clock. */
function proofLayer(getNow) {
  const registry = createIssuanceRegistry();
  const issuer = createProofIssuer({ accountId: SELF, secret: SECRET, registry });
  const verifier = createProofVerifier({ accountId: SELF, secret: SECRET, clock: getNow, registry });
  return { registry, issuer, verifier };
}

/**
 * Build one world: a real store, one facade over it, one proof layer over the same clock.
 * `facadeFor()` lets a case build a SECOND facade over the SAME store — that is how "the
 * authorisation layer forgot this request but the claim is still there" is expressed.
 */
function world({ transport } = {}) {
  const t = tempDb('world');
  const store = openOfflineStore(t.dbPath, { enabled: false, reads: 0 });
  let now = T0 + 1000;
  const getNow = () => now;
  const transportCalls = [];
  const fakeTransport = transport ?? (async (action, input) => {
    transportCalls.push({ action, input });
    return { ok: true };
  });

  function facadeFor() {
    const facade = createB3GuardedDispatch({
      store,
      accountId: SELF,
      selfUin: SELF,
      clock: getNow,
      ownership: ownership(),
      contractValidator,
      transport: fakeTransport,
    });
    const init = facade.initialize({ now: T0 });
    if (init.ok !== true) throw new Error(`initialize failed: ${init.reason}`);
    return facade;
  }

  return {
    t, store, transportCalls, getNow,
    setNow: (v) => { now = v; },
    advance: (ms) => { now += ms; },
    facade: facadeFor(),
    facadeFor,
    proof: proofLayer(getNow),
    close() { try { store.close(); } catch {} t.cleanup(); },
  };
}

const eventRecord = (requestId, over = {}) => ({
  requestId,
  accountId: SELF,
  sourceKind: 'group',
  sourceId: '1059972926',
  sourceMessageId: `m-${requestId}`,
  issuedAt: T0,
  ttlMs: TTL,
  allowedActions: ['read_posts'],
  targetScope: 'self',
  ...over,
});

/** Issue + register + verify a proof for `requestId`, scoped to `read_posts`. */
function mintProof(layer, requestId, { issuedAt = T0, ttlMs = TTL } = {}) {
  const proof = layer.issuer.issue({
    sourceKind: 'group',
    sourceId: '1059972926',
    sourceMessageId: `m-${requestId}`,
    requestId,
    scope: 'read_posts',
    issuedAt,
    ttlMs,
  });
  layer.verifier.remember(proof);
  return proof;
}

const readPosts = (over = {}) => ({
  requestId: 'req-1',
  action: 'read_posts',
  input: { target_uin: SELF },
  sessionId: 'sess-1',
  callId: 'call-1',
  ...over,
});

/**
 * The composed path used by every case: proof first, then the facade.
 * Returning a distinct `stage:'proof'` keeps the two gates distinguishable in assertions.
 */
async function guardedDispatch(w, { proof, sessionId = 'sess-1', callId = 'call-1', generation } = {}) {
  const verified = w.proof.verifier.verify(proof);
  if (verified.ok !== true) return { ok: false, stage: 'proof', reason: verified.reason };
  return w.facade.dispatch({
    requestId: verified.requestId,
    action: 'read_posts',
    input: { target_uin: SELF },
    sessionId,
    callId,
    ...(generation === undefined ? {} : { generation }),
  });
}

// ── S-1 · proof expiry does not reclaim an existing claim ────────────────────────────
test('S-1a 关联表记录过期后同一 requestId 被拒，且既有 claim 从 1 保持不变', async () => {
  const w = world();
  try {
    assert.equal(w.facade.record(eventRecord('req-1')).ok, true);

    const first = await w.facade.dispatch(readPosts());
    assert.equal(first.ok, true, `前提：第一次必须成功落 claim: ${JSON.stringify(first)}`);
    // NOT an empty assertion: prove the counter really moved off zero before checking it holds.
    assert.equal(w.facade.claimSize(), 1, '前提：claim 必须真的是 1（否则「不变」什么都没证明）');

    // The correlation record expires; the claim must not notice.
    w.setNow(T0 + TTL);
    const second = await w.facade.dispatch(readPosts());
    assert.equal(second.ok, false);
    assert.equal(second.stage, 'correlate', '过期必须在关联表这一关被拒，而不是走到 claim');
    assert.equal(second.reason, CORRELATION_REFUSAL.EXPIRED);
    assert.equal(w.facade.claimSize(), 1, '过期不得回收既有 claim：1 还是 1');
    assert.equal(w.transportCalls.length, 1);
  } finally { w.close(); }
});

test('S-1b proof 过期后同一 requestId 被拒，且既有 claim 从 1 保持不变', async () => {
  const w = world();
  try {
    assert.equal(w.facade.record(eventRecord('req-1')).ok, true);
    const proof = mintProof(w.proof, 'req-1');

    const first = await guardedDispatch(w, { proof, generation: 1 });
    assert.equal(first.ok, true, `前提：第一次必须成功: ${JSON.stringify(first)}`);
    assert.equal(w.facade.claimSize(), 1);

    // Advance past the PROOF's expiry (not merely the correlation record's).
    w.setNow(T0 + TTL);
    const second = await guardedDispatch(w, { proof, generation: 1 });
    assert.equal(second.ok, false);
    assert.equal(second.stage, 'proof', '过期 proof 根本走不到 claim');
    assert.equal(second.reason, 'proof-expired');
    assert.equal(w.facade.claimSize(), 1, 'proof 过期不得回收既有 claim');
    assert.equal(w.transportCalls.length, 1, '过期 proof 不得派发');
  } finally { w.close(); }
});

// ── S-2 · revokeAll keeps the claim; in-flight cancellation is NOT assumed ───────────
test('S-2a revokeAll 后旧 proof 被拒，既有 claim 从 1 保持不变', async () => {
  const w = world();
  try {
    assert.equal(w.facade.record(eventRecord('req-1')).ok, true);
    const proof = mintProof(w.proof, 'req-1');

    const first = await guardedDispatch(w, { proof });
    assert.equal(first.ok, true);
    assert.equal(w.facade.claimSize(), 1, '前提：claim 真的是 1');

    w.proof.verifier.revokeAll();

    const second = await guardedDispatch(w, { proof });
    assert.equal(second.ok, false);
    assert.equal(second.stage, 'proof');
    assert.equal(second.reason, 'proof-revoked');
    assert.equal(w.facade.claimSize(), 1, 'revokeAll 只撤销「可以再调」的权利，不得回收已落下的 claim');
    assert.equal(w.transportCalls.length, 1);
  } finally { w.close(); }
});

test('S-2b 撤销之后即便授权层重新放行，同一调用键仍被 claim 挡住（不假设在途可取消）', async () => {
  const w = world();
  try {
    assert.equal(w.facade.record(eventRecord('req-1')).ok, true);
    const proof = mintProof(w.proof, 'req-1');
    assert.equal((await guardedDispatch(w, { proof })).ok, true);
    assert.equal(w.facade.claimSize(), 1, '前提：claim 真的是 1');

    w.proof.verifier.revokeAll();

    // The strongest observable form of "the claim is still there": a DIFFERENT facade (fresh
    // correlation table, so the authorisation layer happily re-approves the same requestId)
    // over the SAME store must still be refused — by B2, not by the authorisation layer.
    const other = w.facadeFor();
    assert.equal(other.record(eventRecord('req-1')).ok, true, '前提：新关联表可以重新记录同一 requestId');
    const again = await other.dispatch(readPosts());
    assert.equal(again.ok, false);
    assert.equal(again.stage, 'claim', '必须是 B2 判重，而不是授权层拒绝');
    assert.equal(again.reason, REPLAY_REFUSAL.REPLAY);
    assert.equal(other.claimSize(), 1, 'claim 仍在，且没有被第二次调用改写');
    assert.equal(w.transportCalls.length, 1, '撤销后不得重发');
  } finally { w.close(); }
});

// ── S-3 · a generation change does not clear claims ─────────────────────────────────
test('S-3a 换代后旧代 proof 被拒，既有 claim 从 1 保持不变', async () => {
  const w = world();
  try {
    assert.equal(w.facade.record(eventRecord('req-1')).ok, true);
    const gen1 = mintProof(w.proof, 'req-1');

    assert.equal((await guardedDispatch(w, { proof: gen1, generation: 1 })).ok, true);
    assert.equal(w.facade.claimSize(), 1, '前提：claim 真的是 1');

    const generation2 = w.proof.verifier.revokeAll();
    assert.equal(generation2, 1, '前提：换代确实发生了');

    const stale = await guardedDispatch(w, { proof: gen1, generation: 2 });
    assert.equal(stale.ok, false);
    assert.equal(stale.stage, 'proof');
    assert.equal(stale.reason, 'proof-revoked');
    assert.equal(w.facade.claimSize(), 1, '换代不得清空既有 claim');
  } finally { w.close(); }
});

test('S-3b 同一 registry 内不得重新签发同一 requestId（新代不能用旧 requestId 刷新）', async () => {
  const w = world();
  try {
    assert.equal(w.facade.record(eventRecord('req-1')).ok, true);
    mintProof(w.proof, 'req-1');
    w.proof.verifier.revokeAll();
    // "First issuance wins; never refreshed" is the property that stops a new generation from
    // resurrecting an old requestId. It is enforced at ISSUANCE, which is why there is no
    // facade-level re-issue path to test.
    assert.throws(() => mintProof(w.proof, 'req-1'), /requestId already issued/);
  } finally { w.close(); }
});

test('S-3c 独立新代签发同一 requestId 可以通过 proof，但同一调用键仍被 claim 拒', async () => {
  const w = world();
  try {
    assert.equal(w.facade.record(eventRecord('req-1')).ok, true);
    const gen1 = mintProof(w.proof, 'req-1');
    assert.equal((await guardedDispatch(w, { proof: gen1, generation: 1 })).ok, true);
    assert.equal(w.facade.claimSize(), 1, '前提：claim 真的是 1');

    // A genuinely separate trusted side (new registry => new generation) re-issues the same
    // requestId. Its proof VERIFIES — the authorisation layer now approves this request again.
    w.proof.verifier.revokeAll();
    const fresh = proofLayer(w.getNow);
    const gen2Proof = mintProof(fresh, 'req-1');
    assert.equal(fresh.verifier.verify(gen2Proof).ok, true, '前提：新代 proof 必须真的能通过校验');

    const again = await w.facade.dispatch({
      requestId: 'req-1', action: 'read_posts', input: { target_uin: SELF },
      sessionId: 'sess-1', callId: 'call-1', generation: 2,
    });
    assert.equal(again.ok, false, '新代 proof 不能让同一个调用再跑一次');
    assert.equal(again.stage, 'claim', '必须红在 claim 阶段（claim 已存在），不是授权阶段');
    assert.equal(again.reason, REPLAY_REFUSAL.REPLAY);
    assert.equal(w.facade.claimSize(), 1, 'claim 键数仍为 1');
    assert.equal(w.transportCalls.length, 1);
  } finally { w.close(); }
});

test('S-3d 反向正控：换代后的新键必须能通过（否则整个 claimer 被锁死了）', async () => {
  const w = world();
  try {
    assert.equal(w.facade.record(eventRecord('req-1')).ok, true);
    const gen1 = mintProof(w.proof, 'req-1');
    assert.equal((await guardedDispatch(w, { proof: gen1, generation: 1 })).ok, true);
    assert.equal(w.facade.claimSize(), 1);

    w.proof.verifier.revokeAll();
    const fresh = proofLayer(w.getNow);
    assert.equal(w.facade.record(eventRecord('req-2')).ok, true, '前提：新键的授权记录可以写入');
    const gen2Proof = mintProof(fresh, 'req-2');

    const ok = await w.facade.dispatch({
      requestId: 'req-2', action: 'read_posts', input: { target_uin: SELF },
      sessionId: 'sess-1', callId: 'call-2', generation: 2,
    });
    assert.equal(ok.ok, true, `换代后新键必须能派发，否则所有拒绝类断言都可能是「全锁死」造成的: ${JSON.stringify(ok)}`);
    assert.equal(ok.stage, 'transport');
    assert.equal(w.transportCalls.length, 2);
    assert.equal(w.facade.claimSize(), 2, '两个不同的调用键');
    assert.equal(fresh.verifier.verify(gen2Proof).ok, true);
  } finally { w.close(); }
});

// ── unknown does not reclaim either ─────────────────────────────────────────────────
test('S-4 transport 返回 unknown 后同键再调仍被拒，claim 从 1 保持不变', async () => {
  const w = world({ transport: async () => ({ unknown: true }) });
  try {
    assert.equal(w.facade.record(eventRecord('req-1')).ok, true);
    const first = await w.facade.dispatch(readPosts());
    assert.equal(first.ok, true);
    assert.equal(first.outcome, 'unknown');
    assert.equal(w.facade.claimSize(), 1, '前提：unknown 之后 claim 仍在（真的是 1）');

    const again = await w.facade.dispatch(readPosts());
    assert.equal(again.ok, false);
    assert.equal(again.stage, 'claim');
    assert.equal(again.reason, REPLAY_REFUSAL.REPLAY, 'unknown 不是「可以重发」的信号');
    assert.equal(w.facade.claimSize(), 1);
  } finally { w.close(); }
});
