// B3 sample tests — including the counter-examples Codex demanded.
//
// The verdict this file supports
// ------------------------------
// VALID:   · a request-scope capability is enforced on the trusted side
//          · re-registering an old proof cannot revive it after revocation
//          · a party with no proof / a forged / altered / expired / revoked one cannot execute
// INVALID: · "the native DSH call chain is closed" — a holder of a legitimately issued proof
//            CAN fabricate a new callId/turn/step and still pass (case FANOUT).
//          · "the signed fields describe a real QQ event" — `issue()` trusts its caller; a
//            caller-supplied `sourceKind:'synthetic-event'` verifies fine (case B3-17).

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';

import {
  PROOF_VERSION,
  DEFAULT_PROOF_TTL_MS,
  createIssuanceRegistry,
  createProofIssuer,
  createProofVerifier,
  materialOf,
} from '../src/core/qzone-origin-proof-offline.mjs';

const ACCOUNT = 9876543210;
const SECRET = randomBytes(32);
const T0 = 1_800_000_000_000;

const realEvent = (over = {}) => ({
  sourceKind: 'group',
  sourceId: '1059972926',
  sourceMessageId: '7412345678901234567',
  requestId: randomUUID(),
  scope: 'read_posts',
  issuedAt: T0,
  ttlMs: DEFAULT_PROOF_TTL_MS,
  nonce: randomUUID(),
  ...over,
});

/** Wires issuer + verifier through one registry, exactly as production would. */
function wired(clockValue = T0 + 1000) {
  let now = clockValue;
  const clock = () => now;
  const registry = createIssuanceRegistry();
  const issuer = createProofIssuer({ accountId: ACCOUNT, secret: SECRET, registry });
  const verifier = createProofVerifier({ accountId: ACCOUNT, secret: SECRET, clock, registry });
  return {
    issuer, verifier, registry,
    setNow: (v) => { now = v; },
    /** Issue + register, the normal trusted-side flow. */
    mint(over = {}) {
      const proof = issuer.issue(realEvent(over));
      verifier.remember(proof);
      return proof;
    },
  };
}

// ── 1. the happy path ────────────────────────────────────────────────────────────────
test('B3-1 正常可信来源：签发 → 登记 → 转交 → 验证通过 → 执行一次', () => {
  const { mint, verifier } = wired();
  const proof = mint();
  const out = verifier.verifyDelivery({ proof, callId: 'c1', turn: 1, step: 1, action: 'read_posts', target: '456' });
  assert.equal(out.ok, true);
  assert.equal(out.requestId, proof.requestId);
  assert.equal(out.scope, 'read_posts');
  assert.equal(verifier.consumedCount(), 1);
});

// ── 2. no proof / garbage ───────────────────────────────────────────────────────────
test('B3-2 无 proof 或结构损坏一律拒绝', () => {
  const { verifier } = wired();
  assert.equal(verifier.verify(undefined).reason, 'proof-malformed');
  assert.equal(verifier.verify(null).reason, 'proof-malformed');
  assert.equal(verifier.verify('nope').reason, 'proof-malformed');
  assert.equal(verifier.verify({}).reason, 'proof-version');
  assert.equal(verifier.verifyDelivery({}).ok, false);
});

// ── 3. tampering ────────────────────────────────────────────────────────────────────
test('B3-3 篡改任一签名字段必须验签失败', () => {
  const { mint, verifier } = wired();
  const proof = mint();
  for (const field of ['sourceKind', 'sourceId', 'sourceMessageId', 'requestId', 'scope', 'nonce']) {
    assert.equal(verifier.verify({ ...proof, [field]: 'tampered-value' }).ok, false, `篡改 ${field} 必须被拒`);
  }
  assert.equal(verifier.verify({ ...proof, accountId: 999 }).reason, 'proof-account-mismatch');
});

test('B3-4 换账号签发不得通过另一账号的 verifier', () => {
  const other = createIssuanceRegistry();
  const otherIssuer = createProofIssuer({ accountId: 111, secret: randomBytes(32), registry: other });
  const { verifier } = wired();
  const proof = otherIssuer.issue(realEvent());
  assert.equal(verifier.verify(proof).reason, 'proof-account-mismatch');
});

test('B3-5 用不同密钥伪造签名必须被拒', () => {
  const { verifier } = wired();
  const attackerReg = createIssuanceRegistry();
  const attacker = createProofIssuer({ accountId: ACCOUNT, secret: randomBytes(32), registry: attackerReg });
  const forged = attacker.issue(realEvent());
  // Even if the forged requestId somehow got registered, the MAC is wrong.
  try { verifier.remember(forged); } catch { /* registry refuses unknown issuance; fine */ }
  const out = verifier.verify(forged);
  assert.equal(out.ok, false);
  assert.ok(['proof-signature-invalid', 'proof-unknown-request'].includes(out.reason), `实际 ${out.reason}`);
});

// ── 4. window / revocation ──────────────────────────────────────────────────────────
test('B3-6 过期 / 未生效 / 撤销后一律拒绝', () => {
  const { mint, verifier, setNow } = wired();
  const proof = mint({ issuedAt: T0, ttlMs: 1000 });

  setNow(T0 - 1);
  assert.equal(verifier.verify(proof).reason, 'proof-not-yet-valid');
  setNow(T0 + 1000);
  assert.equal(verifier.verify(proof).reason, 'proof-expired');

  setNow(T0 + 1);
  assert.equal(verifier.verify(proof).ok, true, '窗口内必须通过');
  verifier.revokeAll();
  assert.equal(verifier.verify(proof).reason, 'proof-revoked', '撤销后旧 proof 立即失效');
});

test('B3-7 未登记过的 proof 必须拒绝', () => {
  const { issuer, verifier } = wired();
  const proof = issuer.issue(realEvent());   // issued but never remembered
  assert.equal(verifier.verify(proof).reason, 'proof-unknown-request');
});

// ── 4b. registration cannot refresh an old proof (defect Codex reproduced) ──────────
test('B3-18 撤销后重复 remember 同一旧 proof 不得复活（Codex 复现的缺陷）', () => {
  const { mint, verifier, registry } = wired();
  const proof = mint();

  assert.equal(verifier.verify(proof).ok, true, '前提：撤销前有效');
  verifier.revokeAll();
  assert.equal(verifier.verify(proof).reason, 'proof-revoked');

  // Re-register the SAME old object. Before the fix this bumped the generation and revived it.
  verifier.remember(proof);
  assert.equal(verifier.verify(proof).reason, 'proof-revoked', '同一旧对象重复登记不得复活');

  // Same proof after a JSON round trip (a different object with identical bytes).
  const copy = JSON.parse(JSON.stringify(proof));
  verifier.remember(copy);
  assert.equal(verifier.verify(copy).reason, 'proof-revoked', '序列化副本重复登记不得复活');

  // The registry record itself must still carry the ORIGINAL issuance generation.
  assert.equal(registry.get(proof.requestId).issuedGeneration, 0);
  assert.equal(verifier.revocationGeneration, 1);
});

test('B3-19 撤销后重新签发的新 proof 可用（代际由 trusted 侧共享计数）', () => {
  const { mint, verifier, issuer, registry } = wired();
  const old = mint();
  verifier.revokeAll();
  assert.equal(verifier.verify(old).reason, 'proof-revoked', '旧签发失效');

  const fresh = issuer.issue(realEvent());
  verifier.remember(fresh);
  // The generation lives in the registry, so the issuer stamps the CURRENT one and a fresh
  // proof is valid again. (Before the counter was shared this case was red — recorded here so
  // the reason for the design is visible.)
  assert.equal(registry.get(fresh.requestId).issuedGeneration, 1);
  assert.equal(verifier.verify(fresh).ok, true, '撤销之后的新签发必须可用');
  // And the OLD proof stays dead even after the new issuance.
  assert.equal(verifier.verify(old).reason, 'proof-revoked');
});

test('B3-20 remember 拒绝从未由本侧签发的 proof 对象（伪造形状不登记）', () => {
  const { verifier } = wired();
  const shape = {
    v: PROOF_VERSION, accountId: ACCOUNT, sourceKind: 'group', sourceId: '1',
    sourceMessageId: '2', requestId: randomUUID(), scope: 'read_posts',
    issuedAt: T0, expiresAt: T0 + 1000, nonce: randomUUID(),
    signature: Buffer.alloc(32).toString('base64url'),
  };
  assert.throws(() => verifier.remember(shape), /not issued by this trusted side/,
    '未签发的对象不得登记');
  assert.equal(verifier.registeredCount(), 0, '拒绝后注册数必须保持 0');
});

// ── 4c. remember must demand the EXACT signed material ─────────────────────────────
//
// Measured defect (Codex): `{...p, nonce:'different', signature:'invalid'}` was ACCEPTED by
// remember(), because only 6 fields were compared. The bogus object pre-registered the slot
// (registration count 0 -> 1) and the ORIGINAL proof then verified — a registration the caller
// was never authorised to create. Fixed by recording the canonical signed-material digest at
// issuance and demanding a byte-identical material plus a verifying MAC at registration.
const tampers = [
  ['伪造签名（换 uuid nonce）', (p) => ({ ...p, nonce: randomUUID(), signature: 'A'.repeat(43) })],
  ['伪造签名（同 nonce）', (p) => ({ ...p, signature: 'A'.repeat(43) })],
  ['替换 version', (p) => ({ ...p, v: 99 })],
  ['替换 accountId', (p) => ({ ...p, accountId: 222 })],
  ['替换 scope', (p) => ({ ...p, scope: 'publish' })],
  ['替换 sourceMessageId', (p) => ({ ...p, sourceMessageId: 'other-event' })],
  ['替换 issuedAt', (p) => ({ ...p, issuedAt: T0 + 5 })],
  ['替换 nonce（合法 uuid）', (p) => ({ ...p, nonce: randomUUID() })],
];

for (const [label, mutate] of tampers) {
  test(`B3-23 remember 拒绝篡改对象：${label}（注册数不变、原真 proof 不受影响）`, () => {
    const { issuer, verifier } = wired();
    const p = issuer.issue(realEvent());
    assert.equal(verifier.registeredCount(), 0, '前提：签发后尚未登记');

    assert.throws(() => verifier.remember(mutate(p)), /disagrees with the issuance record|does not verify|malformed|missing/,
      `${label} 必须被 remember 拒绝`);
    assert.equal(verifier.registeredCount(), 0, '被拒对象不得占用注册位');

    // The genuine proof must still be registrable and verifiable afterwards.
    verifier.remember(p);
    assert.equal(verifier.registeredCount(), 1);
    assert.equal(verifier.verify(p).ok, true, '原真 proof 登记后必须可用');
  });
}

test('B3-24 同一真 proof 的 JSON 往返副本可正常登记（不依赖对象身份）', () => {
  const { issuer, verifier } = wired();
  const p = issuer.issue(realEvent());
  const copy = JSON.parse(JSON.stringify(p));      // different object, identical bytes
  verifier.remember(copy);                         // must NOT be rejected as a tamper
  assert.equal(verifier.registeredCount(), 1, '同一 proof 的副本应可登记');
  assert.equal(verifier.verify(p).ok, true);
  assert.equal(verifier.verify(copy).ok, true);
});

test('B3-21 remember 拒绝与签发记录不一致的 proof 字段', () => {
  const { issuer, verifier } = wired();
  const proof = issuer.issue(realEvent({ scope: 'read_posts' }));
  // Same requestId, different scope: signature is broken but remember must ALSO refuse.
  assert.throws(() => verifier.remember({ ...proof, scope: 'publish' }), /disagrees with the issuance record/);
});

// ── 5. scope + callId de-dup ────────────────────────────────────────────────────────
test('B3-8 越 scope 的动作必须拒绝', () => {
  const { mint, verifier } = wired();
  const proof = mint({ scope: 'read_posts' });
  const denied = verifier.verifyDelivery({ proof, callId: 'c1', turn: 1, step: 1, action: 'publish' });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'delivery-scope-violation');
  assert.equal(denied.expected, 'read_posts');
  assert.equal(verifier.verifyDelivery({ proof, callId: 'c1', turn: 1, step: 1, action: 'read_posts' }).ok, true);
});

test('B3-9 同一 (request, callId) 第二次投递必须拒绝', () => {
  const { mint, verifier } = wired();
  const proof = mint();
  assert.equal(verifier.verifyDelivery({ proof, callId: 'c1', turn: 1, step: 1, action: 'read_posts' }).ok, true);
  const again = verifier.verifyDelivery({ proof, callId: 'c1', turn: 1, step: 2, action: 'read_posts' });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'delivery-call-already-consumed');
});

test('B3-10 同 requestId 换 callId 是合法的多调用（各自一次）', () => {
  const { mint, verifier } = wired();
  const proof = mint();
  assert.equal(verifier.verifyDelivery({ proof, callId: 'c1', turn: 1, step: 1, action: 'read_posts' }).ok, true);
  assert.equal(verifier.verifyDelivery({ proof, callId: 'c2', turn: 1, step: 1, action: 'read_posts' }).ok, true);
  assert.equal(verifier.consumedCount(), 2);
  assert.equal(verifier.verifyDelivery({ proof, callId: 'c1', turn: 1, step: 2, action: 'read_posts' }).ok, false);
});

// ── 6. THE COUNTER-EXAMPLES ─────────────────────────────────────────────────────────
test('B3-11 【关键反例】合法 proof 被同 SID 其他程序持用：伪造全新 callId/turn/step 仍能通过', () => {
  const { mint, verifier } = wired();
  const genuineProof = mint({ scope: 'read_posts' });

  assert.equal(
    verifier.verifyDelivery({ proof: genuineProof, callId: 'call-real', turn: 1, step: 1, action: 'read_posts' }).ok,
    true,
  );
  const fabricated = verifier.verifyDelivery({
    proof: genuineProof, callId: 'call-invented-by-attacker', turn: 99, step: 7, action: 'read_posts', target: '456',
  });
  assert.equal(fabricated.ok, true, '本样品无法阻止——这正是「请求级能力」与「逐调用证明」的差距');
  // Honest verdict, not a downgrade: request-scope capability ENFORCED, native chain NOT proven.
});

test('B3-12 【关键反例】一个 proof 扇出多个伪造 call（全部通过）', () => {
  const { mint, verifier } = wired();
  const proof = mint({ scope: 'read_posts' });
  const fanout = [];
  for (let i = 0; i < 5; i += 1) {
    fanout.push(verifier.verifyDelivery({ proof, callId: `invented-${i}`, turn: 10 + i, step: 1, action: 'read_posts' }).ok);
  }
  assert.deepEqual(fanout, [true, true, true, true, true],
    '同一 proof 可扇出为多个「调用」——逐调用绑定缺失的直接证据');
  assert.equal(verifier.consumedCount(), 5);
});

test('B3-13 已消费调用改 turn/step 仍被拒', () => {
  const { mint, verifier } = wired();
  const proof = mint();
  assert.equal(verifier.verifyDelivery({ proof, callId: 'c1', turn: 1, step: 1, action: 'read_posts' }).ok, true);
  const moved = verifier.verifyDelivery({ proof, callId: 'c1', turn: 2, step: 3, action: 'read_posts' });
  assert.equal(moved.ok, false);
  assert.equal(moved.reason, 'delivery-call-already-consumed');
});

test('B3-14 【关键反例】有效 proof 换目标仍通过（target 未绑定）', () => {
  const { mint, verifier } = wired();
  const proof = mint({ scope: 'read_posts' });
  assert.equal(verifier.verifyDelivery({ proof, callId: 'c1', turn: 1, step: 1, action: 'like' }).ok, false);
  const retarget = verifier.verifyDelivery({
    proof, callId: 'c2', turn: 1, step: 1, action: 'read_posts', target: '999999',
  });
  assert.equal(retarget.ok, true, '目标未被签名 —— 必须由策略层的目标白名单另行约束');
});

// ── 6b. the OTHER gap: issue() trusts its caller ────────────────────────────────────
test('B3-17 【关键反例】issue() 信任调用方：假形状字段也能签出可验证的 proof', () => {
  const { issuer, verifier } = wired();
  // This is NOT a "leaked external vulnerability" — issue() is a trusted-internal entry point.
  // It is a statement about what the signature does and does not prove.
  const synthetic = issuer.issue(realEvent({
    sourceKind: 'synthetic-event',
    sourceId: '999',
    sourceMessageId: 'not-a-real-event',
  }));
  verifier.remember(synthetic);
  assert.equal(verifier.verify(synthetic).ok, true,
    '签名只证明「本侧签过这组字段」，不证明「字段来自真实 QQ 事件」');

  // Binding to real events requires a trusted inbound channel on the B side; the offline
  // sample has none. Do not describe issue() as "signs from a real QQ event".
});

// ── 7. structural properties ───────────────────────────────────────────────────────
test('B3-15 proof 是纯 JSON 安全的：不含密钥、可跨进程传输、序列化后仍可验证', () => {
  const { mint, verifier } = wired();
  const proof = mint();
  const wire = JSON.parse(JSON.stringify(proof));
  assert.equal(wire.v, PROOF_VERSION);
  assert.equal(/secret|key|hmac/i.test(JSON.stringify(proof)), false, 'proof 里不得含密钥材料');
  assert.equal(verifier.verify(wire).ok, true, '过 JSON 往返后仍应验签通过');
  // But: being model-invisible and JSON-safe does NOT make it secret from other A processes.
});

test('B3-16 签发端拒绝缺失字段（不允许用调用方给的字段凑）', () => {
  const { issuer } = wired();
  const base = realEvent();
  for (const field of ['sourceKind', 'sourceId', 'sourceMessageId', 'requestId', 'scope']) {
    const incomplete = { ...base };
    delete incomplete[field];
    assert.throws(() => issuer.issue(incomplete), new RegExp(field), `缺少 ${field} 必须抛错`);
  }
});

test('B3-22 同一 requestId 重复签发必须抛错（签发记录不可刷新）', () => {
  const { issuer } = wired();
  const ev = realEvent();
  issuer.issue(ev);
  assert.throws(() => issuer.issue(ev), /requestId already issued/);
});

// ── 4d. unambiguous signed material (NUL-join defect Codex measured) ────────────────
//
// The material used to be the field values joined with NUL, which is NOT injective: a NUL
// inside a value shifts the field boundary, so two different tuples sign the same bytes.
// Codex measured this exact swap being accepted with the original signature:
//
//     issue({ sourceKind: 'private\u0000other', sourceId: '123', ... })
//     alter to { sourceKind: 'private', sourceId: 'other\u0000123' }  -> verify() ok:true
//
// The material is now a JSON array (fixed order, explicit types) behind a domain separator,
// so interior NULs are escaped and a boundary shift changes the bytes.
test('B3-25 【碰撞对抗】NUL 跨字段边界的两种元组不得共用同一签名材料', () => {
  const { issuer, verifier } = wired();
  const s = '\u0000';
  const p = issuer.issue(realEvent({ sourceKind: `private${s}other`, sourceId: '123' }));
  verifier.remember(p);
  assert.equal(verifier.verify(p).ok, true, '前提：原 proof 有效');

  // Same joined bytes under the old encoding; different field values.
  const altered = { ...p, sourceKind: 'private', sourceId: `other${s}123` };
  const out = verifier.verify(altered);
  assert.equal(out.ok, false, '边界位移后必须验签失败');
  assert.equal(out.reason, 'proof-signature-invalid');
});

test('B3-26 各类 NUL 位移组合一律验签失败（表驱动）', () => {
  const s = '\u0000';
  const swaps = [
    ['sourceKind/sourceId', (p) => ({ ...p, sourceKind: 'group', sourceId: `105${s}x` })],
    ['sourceId/sourceMessageId', (p) => ({ ...p, sourceId: '105', sourceMessageId: `m${s}x` })],
    ['requestId/scope', (p) => ({ ...p, requestId: 'r', scope: `read_posts${s}x` })],
    ['scope/nonce', (p) => ({ ...p, scope: 'read_posts', nonce: `${randomUUID()}${s}x` })],
    ['尾随 NUL', (p) => ({ ...p, scope: `read_posts${s}` })],
    ['前导 NUL', (p) => ({ ...p, scope: `${s}read_posts` })],
  ];
  for (const [label, mutate] of swaps) {
    const { issuer, verifier } = wired();
    const p = issuer.issue(realEvent({ scope: 'read_posts', sourceMessageId: 'm1' }));
    verifier.remember(p);
    assert.equal(verifier.verify(mutate(p)).ok, false, `${label} 位移必须被拒`);
  }
});

test('B3-27 accountId 的字符串形式不得通过；并直接断言 materialOf 对 number/string 产出不同字节', () => {
  const { issuer, verifier, registry } = wired();
  const p = issuer.issue(realEvent());
  verifier.remember(p);
  assert.equal(verifier.verify(p).ok, true);

  // accountId is a number in the tuple; the string form must NOT verify.
  //
  // WORDING (Codex): `verify()` stops at the accountId TYPE comparison, so this half only
  // proves "the string form is refused". It does NOT independently demonstrate that the JSON
  // array encoding distinguishes number from string. That property is therefore asserted
  // DIRECTLY below, on the encoder itself, rather than inferred from verify()'s early exit.
  const asString = { ...p, accountId: String(ACCOUNT) };
  assert.equal(verifier.verify(asString).ok, false, '字符串形式的 accountId 不得通过');
  assert.notEqual(
    materialOf({ ...p, accountId: ACCOUNT }),
    materialOf({ ...p, accountId: String(ACCOUNT) }),
    'materialOf 必须对 number 与 string 产出不同字节',
  );

  // And the registry record keeps the material digest of the exact issuance.
  assert.equal(typeof registry.get(p.requestId).materialDigest, 'string');
  assert.equal(registry.get(p.requestId).materialDigest.length, 64);
});

test('B3-28 同一真 proof 的 JSON 往返仍通过（新编码不依赖对象身份）', () => {
  const { issuer, verifier } = wired();
  const p = issuer.issue(realEvent());
  verifier.remember(JSON.parse(JSON.stringify(p)));
  assert.equal(verifier.registeredCount(), 1);
  assert.equal(verifier.verify(JSON.parse(JSON.stringify(p))).ok, true);
});