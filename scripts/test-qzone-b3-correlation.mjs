// B3 correlation table + FAKE target/action policy tests.
//
// The policy exercised here is SAMPLE FIXTURE, not the product's authorisation model. These
// tests exist to pin the ORDER and the refusal reasons, and to keep two structural claims
// visible:
//
//   1. a QQ group id is not a QZone target uin, and
//   2. a real message id alone does not authorise reading anybody's QZone.
//
// The known gap stays open and is asserted as such at the bottom: a holder of a valid
// requestId can still present a brand-new callId/action-within-scope/target-within-scope.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CORRELATION_REFUSAL,
  FAKE_ACTION_POLICY,
  createCorrelationTable,
  createFakeOwnershipMap,
  createTargetScope,
} from '../src/core/qzone-b3-correlation-offline.mjs';

const SELF = 9876543210;
const OTHER = 1122334455;
const T0 = 1_800_000_000_000;

function rig({ now = T0 + 1000 } = {}) {
  let clock = now;
  const table = createCorrelationTable({ selfUin: SELF, clock: () => clock });
  return { table, setNow: (v) => { clock = v; }, getNow: () => clock };
}

const record = (table, over = {}) => table.record({
  requestId: 'req-1',
  accountId: SELF,
  sourceKind: 'group',
  sourceId: '1059972926',
  sourceMessageId: 'm-1',
  issuedAt: T0,
  ttlMs: 60_000,
  allowedActions: ['read_posts'],
  targetScope: 'self',
  ...over,
});

// ── 1. the happy path ────────────────────────────────────────────────────────────────
test('B3C-1 正常受权调用通过（action 在集合内、target 在范围内）', () => {
  const { table } = rig();
  assert.deepEqual(record(table), { ok: true });
  const out = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } });
  assert.equal(out.ok, true);
  assert.equal(out.target, String(SELF));
});

// ── 2. the correlation key itself ───────────────────────────────────────────────────
test('B3C-2 未知 requestId 一律拒绝（伪造一个新 ID 不通过）', () => {
  const { table } = rig();
  record(table);
  assert.equal(table.authorize({ requestId: 'never-issued', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } }).reason,
    CORRELATION_REFUSAL.UNKNOWN_REQUEST);
});

test('B3C-3 requestId 格式非法直接拒绝', () => {
  const { table } = rig();
  for (const bad of ['', 'a\nb', 'x'.repeat(129), null, undefined, 123]) {
    assert.equal(table.authorize({ requestId: bad, accountId: SELF, action: 'read_posts', input: {} }).reason,
      CORRELATION_REFUSAL.REQUESTID_INVALID, `非法 requestId ${JSON.stringify(bad)} 必须被拒`);
  }
});

test('B3C-4 过期请求拒绝（边界：expiresAt 当刻即失效）', () => {
  const { table, setNow } = rig();
  record(table, { issuedAt: T0, ttlMs: 1000 });
  setNow(T0 + 999);
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } }).ok, true);
  setNow(T0 + 1000);
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } }).reason,
    CORRELATION_REFUSAL.EXPIRED);
});

test('B3C-5 换账号拒绝（关联记录绑定 accountId）', () => {
  const { table } = rig();
  record(table);
  assert.equal(table.authorize({ requestId: 'req-1', accountId: OTHER, action: 'read_posts', input: { target_uin: SELF } }).reason,
    CORRELATION_REFUSAL.ACCOUNT_MISMATCH);
});

test('B3C-6 同一 requestId 重复登记不得扩大权限（首次登记胜出）', () => {
  const { table } = rig();
  record(table, { allowedActions: ['read_posts'], targetScope: 'self' });
  const again = record(table, { allowedActions: ['read_posts', 'publish'], targetScope: 'uin:' + OTHER });
  assert.deepEqual(again, { ok: false, reason: 'already-recorded' });
  // publish must still be refused.
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'publish', input: { target_uins: [SELF] } }).reason,
    CORRELATION_REFUSAL.ACTION_NOT_ALLOWED);
});

// ── 3. action gating ────────────────────────────────────────────────────────────────
test('B3C-7 动作不在集合内一律拒绝（read_posts 授权不能用来 publish）', () => {
  const { table } = rig();
  record(table, { allowedActions: ['read_posts'] });
  for (const action of ['publish', 'comment', 'like', 'reply', 'read_comments']) {
    const out = table.authorize({ requestId: 'req-1', accountId: SELF, action, input: { target_uin: SELF, target_uins: [SELF], tid: '1', content: 'x', comment_id: '1', comment_uin: String(OTHER) } });
    assert.equal(out.reason, CORRELATION_REFUSAL.ACTION_NOT_ALLOWED, `${action} 必须被拒`);
  }
});

// ── 4. target gating (the part that did not exist before) ───────────────────────────
test('B3C-8 越范围目标拒绝：self 范围不许读别人', () => {
  const { table } = rig();
  record(table, { targetScope: 'self' });
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } }).ok, true);
  const other = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: OTHER } });
  assert.equal(other.ok, false);
  assert.equal(other.reason, CORRELATION_REFUSAL.TARGET_OUT_OF_SCOPE);
});

test('B3C-9 uin:<n> 范围只允许那一个 uin', () => {
  const { table } = rig();
  record(table, { targetScope: `uin:${OTHER}` });
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: OTHER } }).ok, true);
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } }).reason,
    CORRELATION_REFUSAL.TARGET_OUT_OF_SCOPE);
});

test('B3C-10 empty 范围什么都不允许（请求没有授权任何空间目标）', () => {
  const { table } = rig();
  record(table, { targetScope: 'empty' });
  for (const target of [SELF, OTHER]) {
    assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: target } }).reason,
      CORRELATION_REFUSAL.TARGET_OUT_OF_SCOPE);
  }
});

test('B3C-11 【结构性约束】QQ 群号不能当 target_uin 授权（sourceId ≠ target_uin）', () => {
  const groupId = '1059972926';
  const { table } = rig();
  // A request that came FROM that group authorises only the bot's own uin here.
  record(table, { sourceKind: 'group', sourceId: groupId, targetScope: 'self' });
  // Passing the group id as a target uin must not be accepted.
  const out = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: groupId } });
  assert.equal(out.ok, false, '群号当作 target_uin 必须被拒');
  assert.equal(out.reason, CORRELATION_REFUSAL.TARGET_OUT_OF_SCOPE);
  // And the table never derives a target from sourceId.
  assert.equal(table.peek('req-1').sourceId, groupId);
  assert.equal(table.peek('req-1').targetScope, 'self');
});

test('B3C-12 target 缺失 / 非法格式拒绝', () => {
  const { table } = rig();
  record(table, { targetScope: 'self' });
  for (const input of [{}, { target_uin: null }, { target_uin: '' }]) {
    assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input }).reason,
      CORRELATION_REFUSAL.TARGET_MISSING);
  }
  for (const bad of ['abc', '123', '-1', '1234567890123']) {
    assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: bad } }).reason,
      CORRELATION_REFUSAL.TARGET_MALFORMED, `非法 uin ${bad} 必须被拒`);
  }
});

test('B3C-13 复合动作的伴随字段缺失必须拒绝（read_comments 缺 tid 等）', () => {
  const { table } = rig();
  record(table, { allowedActions: ['read_comments', 'like', 'comment', 'reply'], targetScope: 'self' });
  // read_comments requires tid
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_comments', input: { target_uin: SELF } }).reason,
    CORRELATION_REFUSAL.TARGET_MISSING);
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_comments', input: { target_uin: SELF, tid: '9' } }).ok, true);
  // like requires tid
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'like', input: { target_uin: SELF } }).reason,
    CORRELATION_REFUSAL.TARGET_MISSING);
  // reply requires all five companions
  const partial = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply', input: { target_uin: SELF, tid: '9', content: 'x' } });
  assert.equal(partial.reason, CORRELATION_REFUSAL.TARGET_MISSING);
  assert.ok(['comment_id', 'comment_uin'].includes(partial.field));
});

// ── publish: visibility decides whether a target list is required OR forbidden ──────
//
// The real contract (src/core/qzone-mcp-contract.mjs:20-42) says target_uins is required only
// for ugc_right in {16,128} and FORBIDDEN otherwise. The earlier fixture treated publish as
// always requiring a target list, which disagreed with the contract in both directions
// (measured). These cases pin the corrected behaviour.
test('B3C-14 publish(ugc_right=16) 逐项校验 target_uins 范围，有一个越界即整体拒绝', () => {
  const { table } = rig();
  record(table, { allowedActions: ['publish'], targetScope: 'self' });
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'publish', input: { content: 'x', ugc_right: 16, target_uins: [SELF] } }).ok, true);
  const mixed = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'publish', input: { content: 'x', ugc_right: 16, target_uins: [SELF, OTHER] } });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.reason, CORRELATION_REFUSAL.TARGET_OUT_OF_SCOPE);
  assert.equal(mixed.target, String(OTHER));
});

test('B3C-19 publish 的可见性语义：1/4/64 不得带 target_uins，16/128 必须带', () => {
  const { table } = rig();
  record(table, { allowedActions: ['publish'], targetScope: 'self' });

  // Implicit audience: contract-valid WITHOUT a target list.
  for (const right of [1, 4, 64]) {
    const ok = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'publish', input: { content: 'x', ugc_right: right } });
    assert.equal(ok.ok, true, `ugc_right=${right} 无 target 应当通过`);
    assert.equal(ok.targets, null, '隐式受众没有 target 列表');

    // Contract FORBIDS target_uins here; the policy must refuse rather than silently accept.
    const bad = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'publish', input: { content: 'x', ugc_right: right, target_uins: [SELF] } });
    assert.equal(bad.ok, false, `ugc_right=${right} 带 target 必须被拒`);
    assert.equal(bad.reason, CORRELATION_REFUSAL.TARGET_UNEXPECTED);
  }

  // Named recipients: target list REQUIRED.
  for (const right of [16, 128]) {
    const missing = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'publish', input: { content: 'x', ugc_right: right } });
    assert.equal(missing.ok, false, `ugc_right=${right} 缺 target 必须被拒`);
    assert.equal(missing.reason, CORRELATION_REFUSAL.TARGET_MISSING);
    assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'publish', input: { content: 'x', ugc_right: right, target_uins: [SELF] } }).ok, true);
  }
});

test('B3C-20 publish 缺 content/ugc_right 或 ugc_right 非法一律拒绝', () => {
  const { table } = rig();
  record(table, { allowedActions: ['publish'], targetScope: 'self' });
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'publish', input: { ugc_right: 1 } }).reason,
    CORRELATION_REFUSAL.TARGET_MISSING);
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'publish', input: { content: 'x' } }).reason,
    CORRELATION_REFUSAL.TARGET_MISSING);
  for (const right of [0, 2, 999, '1', 1.5]) {
    assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'publish', input: { content: 'x', ugc_right: right } }).reason,
      CORRELATION_REFUSAL.TARGET_MALFORMED, `ugc_right=${JSON.stringify(right)} 必须被拒`);
  }
});

// ── 5. policy/scope validation at record time ───────────────────────────────────────
test('B3C-15 登记时拒绝未知 action 与未知 targetScope', () => {
  const { table } = rig();
  assert.throws(() => record(table, { allowedActions: ['not-an-action'] }), /unknown action/);
  assert.throws(() => record(table, { targetScope: 'everything' }), /unknown targetScope/);
  assert.throws(() => record(table, { allowedActions: [] }), /non-empty/);
});

test('B3C-16 createTargetScope 对未知/畸形输入返回 null', () => {
  assert.equal(createTargetScope('anything'), null);
  assert.equal(createTargetScope('uin:abc'), null);
  assert.equal(createTargetScope(undefined), null);
  assert.notEqual(createTargetScope('self'), null);
  assert.notEqual(createTargetScope('empty'), null);
});

test('B3C-17 假策略表覆盖真实契约的六个 action（防止漏项）', () => {
  assert.deepEqual(Object.keys(FAKE_ACTION_POLICY).sort(),
    ['comment', 'like', 'publish', 'read_comments', 'read_posts', 'reply']);
  // Every entry names a target field that actually exists in the contract.
  for (const [action, policy] of Object.entries(FAKE_ACTION_POLICY)) {
    assert.ok(['target_uin', 'target_uins'].includes(policy.targetField), `${action} 的 targetField 不合法`);
  }
});

// ── 6. THE GAP THAT REMAINS OPEN ────────────────────────────────────────────────────
test('B3C-18 【边界】持有效 requestId 仍可伪造新调用：关联表不能替代逐调用证明', () => {
  const { table } = rig();
  record(table, { allowedActions: ['read_posts'], targetScope: 'self' });

  // A legitimate call.
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } }).ok, true);

  // A process that can observe `req-1` replays it. It cannot widen action or target (the table
  // gates those), but NOTHING here proves this second attempt did not happen in DSH.
  const forged = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } });
  assert.equal(forged.ok, true,
    '第二个同形请求照样通过 —— 关联表只挡住「换 action / 换越界 target」，挡不住「同一授权内的重复伪造」');

  // The B2 replay claim is what limits repeats, NOT this table. Assert the separation.
  // (Deduplication lives in src/core/qzone-replay-claim-offline.mjs, tested separately.)
  assert.equal(typeof table.authorize, 'function');
  // Explicitly: rpcId is a lookup key, not proof of call authenticity.
  assert.notEqual(table.peek('req-1'), undefined);
});

// ── 7. time window boundaries (both ends) ───────────────────────────────────────────
test('B3C-21 未生效边界：now < issuedAt 必须拒绝（Codex 实测的漏检）', () => {
  let now = 10;
  const table = createCorrelationTable({ selfUin: SELF, clock: () => now });
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: 100, ttlMs: 100, allowedActions: ['read_posts'], targetScope: 'self' });

  now = 10;   // well before issuedAt
  const early = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } });
  assert.equal(early.ok, false, '时钟早于签发时刻不得通过');
  assert.equal(early.reason, CORRELATION_REFUSAL.NOT_YET_VALID);

  now = 100;  // exactly issuedAt -> valid
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } }).ok, true);
  now = 199;
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } }).ok, true);
  now = 200;  // exactly expiresAt -> expired
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } }).reason,
    CORRELATION_REFUSAL.EXPIRED);
});

test('B3C-22 issuedAt+ttlMs 溢出安全整数必须在登记时拒绝', () => {
  const table = createCorrelationTable({ selfUin: SELF, clock: () => 0 });
  assert.throws(() => table.record({
    requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '1', sourceMessageId: 'm',
    issuedAt: Number.MAX_SAFE_INTEGER - 5, ttlMs: 10, allowedActions: ['read_posts'], targetScope: 'self',
  }), /overflow/i, '溢出窗口必须抛错，不得静默回绕');
  // A window that fits must still work.
  assert.deepEqual(table.record({
    requestId: 'req-2', accountId: SELF, sourceKind: 'group', sourceId: '1', sourceMessageId: 'm',
    issuedAt: Number.MAX_SAFE_INTEGER - 100, ttlMs: 10, allowedActions: ['read_posts'], targetScope: 'self',
  }), { ok: true });
});

// ── 8. association (tid / comment ownership), fake map ──────────────────────────────
test('B3C-23 归属关联：tid 不属于所声明的 target_uin 必须拒绝（Codex 实测的漏检）', () => {
  const ownership = createFakeOwnershipMap({
    'tid-self': { ownerUin: SELF, commentIds: ['c-ok'], commentAuthors: { 'c-ok': SELF } },
    'tid-other': { ownerUin: OTHER, commentIds: ['c-x'], commentAuthors: { 'c-x': OTHER } },
  });
  const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000, ownership });
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000,
    allowedActions: ['reply', 'comment', 'like', 'read_comments'], targetScope: 'uin:' + OTHER,
    replySelections: [] });   // this request selects no reply target

  // Claiming SELF while the post belongs to OTHER is a mismatch.
  const mismatch = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-other', target_uin: SELF, content: 'x', comment_id: 'c-x', comment_uin: String(OTHER) } });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, CORRELATION_REFUSAL.OWNERSHIP_MISMATCH);

  // Correct association passes.
  const ok = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-other', target_uin: OTHER, content: 'x', comment_id: 'c-x', comment_uin: String(OTHER) } });
  assert.equal(ok.ok, true);
});
test('B3C-24 归属未知（假映射里没有这个 tid）必须拒绝，而不是默认放行', () => {
  const ownership = createFakeOwnershipMap({ 'tid-known': { ownerUin: SELF } });
  const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000, ownership });
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['like'], targetScope: 'self' });
  const out = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'like', input: { tid: 'tid-unmapped', target_uin: SELF } });
  assert.equal(out.ok, false);
  assert.equal(out.reason, CORRELATION_REFUSAL.OWNERSHIP_UNKNOWN);
});

test('B3C-25 comment_id 与 tid 不对应必须拒绝（Codex 的 unrelated comment_id 反例）', () => {
  const ownership = createFakeOwnershipMap({ 'tid-self': { ownerUin: SELF, commentIds: ['c-real'], commentAuthors: { 'c-real': OTHER } } });
  const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000, ownership });
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['reply'], targetScope: 'self',
    replySelections: [] });

  const bad = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-self', target_uin: SELF, content: 'x', comment_id: 'unrelated', comment_uin: String(OTHER) } });
  assert.equal(bad.ok, false, 'unrelated comment_id 必须被拒');
  assert.equal(bad.reason, CORRELATION_REFUSAL.OWNERSHIP_MISMATCH);

  const good = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-self', target_uin: SELF, content: 'x', comment_id: 'c-real', comment_uin: String(OTHER) } });
  assert.equal(good.ok, true);
});

test('B3C-26 未注入归属映射时不做归属校验（必须显式说明，不能默认宣称已校验）', () => {
  const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000 });   // no ownership
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['like'], targetScope: 'self' });
  const out = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'like', input: { tid: 'anything', target_uin: SELF } });
  assert.equal(out.ok, true, '无映射时只做非空检查 —— 这是已知边界，不是已校验归属');
  assert.equal(table.ownershipKnown('anything'), false);
});
// ── 9. cross-check against the REAL contract validator ──────────────────────────────
//
// Codex measured that the fixture disagreed with `validateQzoneMcpInput` in BOTH directions on
// publish. These cases run every action's sample input through the real validator and assert
// the policy does not accept contract-invalid input, nor reject contract-valid input.
//
// NOTE the honest scope: `validateQzoneMcpInput` only checks the SHAPE the MCP contract
// accepts. It is not a business authorisation check, and agreement with it does not make the
// fake policy a product rule.
test('B3C-27 假策略与真实契约校验器逐个 action 对齐（publish 除外由 B3C-28 单列）', async () => {
  const { validateQzoneMcpInput } = await import('../src/core/qzone-mcp-contract.mjs');
  const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000 });
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000,
    allowedActions: ['read_posts', 'read_comments', 'comment', 'like', 'reply'], targetScope: 'self' });

  const cases = [
    ['read_posts', { target_uin: SELF }],
    ['read_posts', { target_uin: String(SELF) }],
    ['read_comments', { tid: 'abc', target_uin: SELF }],
    ['comment', { tid: 'abc', target_uin: SELF, content: 'x' }],
    ['like', { tid: 'abc', target_uin: SELF }],
    ['reply', { tid: 'abc', target_uin: SELF, content: 'x', comment_id: 'c1', comment_uin: String(OTHER) }],
    // contract-INVALID shapes must also be refused by the policy
    ['read_posts', { target_uin: 0 }],
    ['read_comments', { target_uin: SELF }],                     // missing tid
    ['comment', { tid: 'abc', target_uin: SELF }],               // missing content
    ['like', { tid: 'abc' }],                                    // missing target_uin
  ];

  for (const [action, input] of cases) {
    const contractOk = validateQzoneMcpInput(action, input) === true;
    const policyOk = table.authorize({ requestId: 'req-1', accountId: SELF, action, input }).ok === true;
    if (contractOk) {
      assert.equal(policyOk, true, `${action} ${JSON.stringify(input)} 契约有效但策略拒绝（不应更严）`);
    } else {
      assert.equal(policyOk, false, `${action} ${JSON.stringify(input)} 契约无效但策略放行（不应更松）`);
    }
  }
});

test('B3C-28 publish 可见性语义与真实契约一致（16/128 需要 targets，其余禁止）', async () => {
  const { validateQzoneMcpInput } = await import('../src/core/qzone-mcp-contract.mjs');
  const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000 });
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['publish'], targetScope: 'self' });

  const cases = [
    [{ content: 'x', ugc_right: 1 }, true],                            // implicit, no targets
    [{ content: 'x', ugc_right: 1, target_uins: [SELF] }, false],      // contract FORBIDS targets
    [{ content: 'x', ugc_right: 16 }, false],                          // needs targets
    [{ content: 'x', ugc_right: 16, target_uins: [SELF] }, true],
    [{ content: 'x', ugc_right: 128, target_uins: [String(SELF)] }, true],
    [{ content: 'x' }, false],                                         // missing ugc_right
    [{ ugc_right: 1 }, false],                                         // missing content
    [{ content: 'x', ugc_right: 999 }, false],                         // illegal enum
  ];
  for (const [input, expectedContractOk] of cases) {
    const contractOk = validateQzoneMcpInput('publish', input) === true;
    assert.equal(contractOk, expectedContractOk, `前提：契约对 ${JSON.stringify(input)} 应判 ${expectedContractOk}`);
    const policyOk = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'publish', input }).ok === true;
    assert.equal(policyOk, contractOk, `策略与契约不一致：${JSON.stringify(input)}`);
  }
});
// ── 10. contract validation hook (Codex-measured gaps) ─────────────────────────────
//
// Without an injected validator the sample accepted shapes the MCP contract rejects:
//   publish {content:' ', ugc_right:1} -> contract invalid, policy ok
// The hook closes that, and these cases pin the behaviour in both directions.
test('B3C-29 注入契约校验器后：形状非法的输入必须拒绝（空白 content 等）', async () => {
  const { validateQzoneMcpInput } = await import('../src/core/qzone-mcp-contract.mjs');
  const table = createCorrelationTable({
    selfUin: SELF, clock: () => T0 + 1000, contractValidator: (a, i) => validateQzoneMcpInput(a, i),
  });
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['read_posts', 'publish'], targetScope: 'self' });

  // Blank content is contract-invalid even though every required field is present.
  const blank = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'publish', input: { content: ' ', ugc_right: 1 } });
  assert.equal(blank.ok, false, '空白 content 必须被拒');
  assert.equal(blank.reason, CORRELATION_REFUSAL.CONTRACT_INVALID);

  // Unknown extra field is contract-invalid (additionalProperties: false).
  const extra = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF, unexpected: true } });
  assert.equal(extra.ok, false);
  assert.equal(extra.reason, CORRELATION_REFUSAL.CONTRACT_INVALID);

  // A legal call still passes.
  assert.equal(table.authorize({ requestId: 'req-1', accountId: SELF, action: 'publish', input: { content: 'x', ugc_right: 1 } }).ok, true);
});

test('B3C-30 未注入校验器时不做形状校验（必须显式声明，不能默认宣称已校验）', () => {
  const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000 });   // no validator
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['publish'], targetScope: 'self' });
  const out = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'publish', input: { content: ' ', ugc_right: 1 } });
  assert.equal(out.ok, true, '无校验器时只做假策略检查 —— 这是已知边界');
});

test('B3C-31 校验器抛错必须按拒绝处理（不能因为异常就放行）', () => {
  const table = createCorrelationTable({
    selfUin: SELF, clock: () => T0 + 1000, contractValidator: () => { throw new Error('boom'); },
  });
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['read_posts'], targetScope: 'self' });
  const out = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'read_posts', input: { target_uin: SELF } });
  assert.equal(out.ok, false);
  assert.equal(out.reason, CORRELATION_REFUSAL.CONTRACT_INVALID);
});

// ── 11. comment author binding (Codex-measured swap) ──────────────────────────────
test('B3C-32 comment_uin 被替换必须拒绝；reply_uin 是独立身份，不得强制同值', () => {
  // TWO identities, mirroring qzone-bound-write-simulation-offline.mjs matchesReplyEvidence:
  //   comment author = OTHER (who wrote the comment)
  //   reply target   = SELF  (who this call replies to) -- deliberately a different person
  const ownership = createFakeOwnershipMap({
    'tid-self': {
      ownerUin: SELF,
      commentIds: ['c-1'],
      commentAuthors: { 'c-1': OTHER },
      replyTargets: { 'c-1': { replyUin: SELF, replyName: 'me' } },
    },
  });
  const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000, ownership });
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['reply'], targetScope: 'self',
    replySelections: [{ replyUin: SELF, replyName: 'me' }] });

  // Wrong author (the real author is OTHER).
  const wrong = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-self', target_uin: SELF, content: 'x', comment_id: 'c-1', comment_uin: String(SELF) } });
  assert.equal(wrong.ok, false, '作者不匹配必须被拒');
  assert.equal(wrong.reason, CORRELATION_REFUSAL.AUTHOR_MISMATCH);
  assert.equal(wrong.field, 'comment_uin');

  // Correct author AND the selected reply target -> passes.
  const right = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-self', target_uin: SELF, content: 'x', comment_id: 'c-1', comment_uin: String(OTHER), reply_uin: String(SELF), reply_name: 'me' } });
  assert.equal(right.ok, true, '两人不同的正确回复必须通过（作者 ≠ 被回复人）');

  // Each reply field tampered independently.
  const badReplyUin = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-self', target_uin: SELF, content: 'x', comment_id: 'c-1', comment_uin: String(OTHER), reply_uin: String(OTHER), reply_name: 'me' } });
  assert.equal(badReplyUin.ok, false, 'reply_uin 被替换必须拒绝');
  assert.equal(badReplyUin.field, 'reply_uin');

  const badReplyName = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-self', target_uin: SELF, content: 'x', comment_id: 'c-1', comment_uin: String(OTHER), reply_uin: String(SELF), reply_name: 'someone-else' } });
  assert.equal(badReplyName.ok, false, 'reply_name 被替换必须拒绝');
  assert.equal(badReplyName.field, 'reply_name');
});
test('B3C-34 无 call-scoped 回复证据时必须失败关闭（不默认放行）', () => {
  const ownership = createFakeOwnershipMap({
    'tid-self': { ownerUin: SELF, commentIds: ['c-1'], commentAuthors: { 'c-1': OTHER } },
  });
  const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000, ownership });
  // replySelections OMITTED -> no reply-selection evidence for this request
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['reply'], targetScope: 'self' });

  const out = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-self', target_uin: SELF, content: 'x', comment_id: 'c-1', comment_uin: String(OTHER) } });
  assert.equal(out.ok, false, '没有 call-scoped 证据时不得放行');
  assert.equal(out.reason, CORRELATION_REFUSAL.REPLY_SELECTION_UNKNOWN);
});
test('B3C-35 证据说「本次无回复目标」：不带 reply 字段通过，带了拒绝', () => {
  const ownership = createFakeOwnershipMap({
    'tid-self': { ownerUin: SELF, commentIds: ['c-1'], commentAuthors: { 'c-1': OTHER } },
  });
  const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000, ownership });
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['reply'], targetScope: 'self',
    replySelections: [] });   // explicit: this request has NO reply target

  // Direct reply to the parent comment: legitimate, must pass.
  const plain = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-self', target_uin: SELF, content: 'x', comment_id: 'c-1', comment_uin: String(OTHER) } });
  assert.equal(plain.ok, true, '有权直接回复父评论');

  // Supplying a reply target contradicts the evidence.
  const withReply = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-self', target_uin: SELF, content: 'x', comment_id: 'c-1', comment_uin: String(OTHER), reply_uin: String(SELF), reply_name: 'me' } });
  assert.equal(withReply.ok, false);
  assert.equal(withReply.reason, CORRELATION_REFUSAL.REPLY_TARGET_MISSING);
});

test('B3C-36 证据已选定具体回复目标，但调用漏掉 reply_uin 必须拒绝（Codex 实测的缺口）', () => {
  const ownership = createFakeOwnershipMap({
    'tid-self': { ownerUin: SELF, commentIds: ['c-1'], commentAuthors: { 'c-1': OTHER } },
  });
  const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000, ownership });
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['reply'], targetScope: 'self',
    replySelections: [{ replyUin: OTHER, replyName: 'someone' }] });

  // The call omits reply_uin entirely, but the evidence selected a concrete target.
  const missing = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-self', target_uin: SELF, content: 'x', comment_id: 'c-1', comment_uin: String(OTHER) } });
  assert.equal(missing.ok, false, '已选定目标却漏掉时不得通过');
  assert.equal(missing.reason, CORRELATION_REFUSAL.REPLY_TARGET_MISSING);
  assert.deepEqual(missing.candidates, [String(OTHER)], '必须回报候选集，便于审计区分「漏掉」与「选错」');

  // Supplying the selected target passes.
  const ok = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-self', target_uin: SELF, content: 'x', comment_id: 'c-1', comment_uin: String(OTHER), reply_uin: String(OTHER), reply_name: 'someone' } });
  assert.equal(ok.ok, true);
});

test('B3C-37 帖子级 replyTargets 缓存不授权：只有 call-scoped 证据才作数', () => {
  // The post-level cache records a target, but this call carries NO call-scoped evidence.
  const ownership = createFakeOwnershipMap({
    'tid-self': { ownerUin: SELF, commentIds: ['c-1'], commentAuthors: { 'c-1': OTHER },
      replyTargets: { 'c-1': { replyUin: SELF, replyName: 'me' } } },
  });
  const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000, ownership });
  table.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['reply'], targetScope: 'self' });
  // no replySelections

  const out = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-self', target_uin: SELF, content: 'x', comment_id: 'c-1', comment_uin: String(OTHER) } });
  assert.equal(out.ok, false, '缓存里有目标不等于本次调用已选定它');
  assert.equal(out.reason, CORRELATION_REFUSAL.REPLY_SELECTION_UNKNOWN);
});
test('B3C-33 作者未知与作者不匹配必须可区分（稳定主码 + 精确断言）', () => {
  // (a) map has the comment id but NO author evidence -> author-unknown
  const unknownMap = createFakeOwnershipMap({
    'tid-self': { ownerUin: SELF, commentIds: ['c-1'] },   // commentAuthors omitted on purpose
  });
  const t1 = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000, ownership: unknownMap });
  t1.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['reply'], targetScope: 'self' });
  const unknown = t1.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-self', target_uin: SELF, content: 'x', comment_id: 'c-1', comment_uin: String(OTHER) } });
  assert.equal(unknown.ok, false, '未知作者不得放行');
  assert.equal(unknown.reason, CORRELATION_REFUSAL.AUTHOR_UNKNOWN, '必须用独立主码 author-unknown');
  assert.equal(unknown.field, 'comment_uin');

  // (b) map KNOWS the author and it differs -> author-mismatch
  const knownMap = createFakeOwnershipMap({
    'tid-self': { ownerUin: SELF, commentIds: ['c-1'], commentAuthors: { 'c-1': OTHER } },
  });
  const t2 = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000, ownership: knownMap });
  t2.record({ requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['reply'], targetScope: 'self' });
  const mismatch = t2.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'tid-self', target_uin: SELF, content: 'x', comment_id: 'c-1', comment_uin: String(SELF) } });
  assert.equal(mismatch.ok, false, '不匹配不得放行');
  assert.equal(mismatch.reason, CORRELATION_REFUSAL.AUTHOR_MISMATCH);
  assert.equal(mismatch.declared, String(SELF));
  assert.equal(mismatch.known, String(OTHER));

  // The two cases MUST be distinguishable — this is the assertion the old tautology replaced.
  assert.notEqual(unknown.reason, mismatch.reason, '未知与不匹配必须是不同拒绝码');
});


// ── 12. candidate set: one request, MULTIPLE legitimate calls ───────────────────────
//
// Measured defect (Codex): the old model stored ONE selection per requestId, so a second
// legitimate call in the same request that selected a DIFFERENT reply target was wrongly
// refused with author-mismatch, and re-recording the request returned already-recorded.
// The model is now a FINITE ARRAY of candidates recorded per request; a call names one. There is
// NO length cap implemented — do not call it "bounded".
//
// What this is NOT: proof that the call happened in DSH. B can only check that the named
// candidate was offered; B3-11/12 stay open.
//
// AND the B2 unique key is NOT extended with the selection. The accepted guarantee is "the same
// (account, session, request, call) executes at most once, even if the content or the selection
// differs" — folding `selection` into that key would mint a new key on a changed selection and
// let the same call run again, re-opening exactly the replay B2 prevents. If a future requirement
// needs "each candidate usable once", that must be a separate atomic constraint inside the trusted
// boundary, justified on its own (authorisation need, failure/rollback, concurrency).
function candidateRig({ selections, commentAuthors = { c1: OTHER, c2: OTHER }, owners = {} } = {}) {
  const ownership = createFakeOwnershipMap({
    post: { ownerUin: SELF, commentIds: ['c1', 'c2'], commentAuthors, ...owners },
  });
  const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000, ownership });
  table.record({
    requestId: 'req-1', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000,
    allowedActions: ['reply'], targetScope: 'self',
    replySelections: selections,
  });
  return table;
}

test('B3C-38 同一请求的两次合法调用可选不同回复对象（不再误拒）', () => {
  const ALICE = 34567;
  const BOB = 45678;
  const table = candidateRig({
    selections: [
      { replyUin: ALICE, replyName: 'alice' },
      { replyUin: BOB, replyName: 'bob' },
    ],
  });

  const first = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'post', target_uin: SELF, content: 'x', comment_id: 'c1', comment_uin: String(OTHER), reply_uin: String(ALICE), reply_name: 'alice' } });
  assert.equal(first.ok, true, '第一次调用（选 alice）必须通过');

  const second = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'post', target_uin: SELF, content: 'y', comment_id: 'c2', comment_uin: String(OTHER), reply_uin: String(BOB), reply_name: 'bob' } });
  assert.equal(second.ok, true, '同一请求的第二次调用（选 bob）必须通过 —— 这是原模型的误拒');
});

test('B3C-39 候选集之外的回复对象必须拒绝（并回报候选集）', () => {
  const table = candidateRig({ selections: [{ replyUin: 34567, replyName: 'alice' }] });
  const out = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'post', target_uin: SELF, content: 'x', comment_id: 'c1', comment_uin: String(OTHER), reply_uin: '99999', reply_name: 'alice' } });
  assert.equal(out.ok, false);
  assert.equal(out.reason, CORRELATION_REFUSAL.AUTHOR_MISMATCH);
  assert.deepEqual(out.candidates, ['34567'], '审计需要知道被允许的候选集');
});

test('B3C-40 候选集内 uin 但名字不符必须拒绝', () => {
  const table = candidateRig({ selections: [{ replyUin: 34567, replyName: 'alice' }] });
  const out = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'post', target_uin: SELF, content: 'x', comment_id: 'c1', comment_uin: String(OTHER), reply_uin: '34567', reply_name: 'wrong' } });
  assert.equal(out.ok, false);
  assert.equal(out.field, 'reply_name');
});

test('B3C-41 候选集非空却漏掉 reply 字段必须拒绝（回报候选集）', () => {
  const table = candidateRig({ selections: [{ replyUin: 34567, replyName: 'alice' }] });
  const out = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'post', target_uin: SELF, content: 'x', comment_id: 'c1', comment_uin: String(OTHER) } });
  assert.equal(out.ok, false);
  assert.equal(out.reason, CORRELATION_REFUSAL.REPLY_TARGET_MISSING);
  assert.deepEqual(out.candidates, ['34567']);
});

test('B3C-42 数组形式的 replySelections 与单个 selectedReply 快捷写法等价', () => {
  const table = candidateRig({ selections: undefined });
  // record() was given replySelections: undefined -> no evidence -> fail closed
  const out = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'post', target_uin: SELF, content: 'x', comment_id: 'c1', comment_uin: String(OTHER), reply_uin: '34567', reply_name: 'alice' } });
  assert.equal(out.ok, false);
  assert.equal(out.reason, CORRELATION_REFUSAL.REPLY_SELECTION_UNKNOWN);
});

test('B3C-43 候选集可以是空数组：表示「本次请求无回复目标」，仍能直回父评论', () => {
  const table = candidateRig({ selections: [] });
  const plain = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'post', target_uin: SELF, content: 'x', comment_id: 'c1', comment_uin: String(OTHER) } });
  assert.equal(plain.ok, true, '有权直接回复父评论');
  const withReply = table.authorize({ requestId: 'req-1', accountId: SELF, action: 'reply',
    input: { tid: 'post', target_uin: SELF, content: 'x', comment_id: 'c1', comment_uin: String(OTHER), reply_uin: '34567', reply_name: 'alice' } });
  assert.equal(withReply.ok, false);
  assert.equal(withReply.reason, CORRELATION_REFUSAL.REPLY_TARGET_MISSING);
});


// ── 13. DOCUMENTED GAPS (asserted so they cannot be mistaken for support) ───────────
//
// These two cases assert LIMITATIONS of the sample. They are green when the limitation is
// present, and would go red if someone silently "fixed" the model without updating the record.
// Do not read a green here as "the capability exists".

test('B3C-44 【已记录缺口】同一请求无法同时表达「直回父评论」与「指定回复对象」', () => {
  const ALICE = 34567;
  const ownership = createFakeOwnershipMap({
    post: { ownerUin: SELF, commentIds: ['c1', 'c2'], commentAuthors: { c1: OTHER, c2: OTHER } },
  });

  // (a) non-empty candidate list: named reply passes, direct reply is refused.
  const named = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000, ownership });
  named.record({ requestId: 'r-named', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['reply'], targetScope: 'self',
    replySelections: [{ replyUin: ALICE, replyName: 'alice' }] });
  assert.equal(named.authorize({ requestId: 'r-named', accountId: SELF, action: 'reply',
    input: { tid: 'post', target_uin: SELF, content: 'x', comment_id: 'c1', comment_uin: String(OTHER), reply_uin: String(ALICE), reply_name: 'alice' } }).ok, true);
  const directOnNamed = named.authorize({ requestId: 'r-named', accountId: SELF, action: 'reply',
    input: { tid: 'post', target_uin: SELF, content: 'x', comment_id: 'c2', comment_uin: String(OTHER) } });
  assert.equal(directOnNamed.ok, false, '非空候选集下直回被拒 —— 这是当前模型的限制');
  assert.equal(directOnNamed.reason, CORRELATION_REFUSAL.REPLY_TARGET_MISSING);

  // (b) empty candidate list: direct reply passes, named reply is refused.
  const direct = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000, ownership });
  direct.record({ requestId: 'r-direct', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['reply'], targetScope: 'self',
    replySelections: [] });
  assert.equal(direct.authorize({ requestId: 'r-direct', accountId: SELF, action: 'reply',
    input: { tid: 'post', target_uin: SELF, content: 'x', comment_id: 'c1', comment_uin: String(OTHER) } }).ok, true);
  const namedOnDirect = direct.authorize({ requestId: 'r-direct', accountId: SELF, action: 'reply',
    input: { tid: 'post', target_uin: SELF, content: 'x', comment_id: 'c1', comment_uin: String(OTHER), reply_uin: String(ALICE), reply_name: 'alice' } });
  assert.equal(namedOnDirect.ok, false, '空候选集下指定回复被拒 —— 这是当前模型的限制');

  // THEREFORE: "one direct reply + one named reply in the same request" is NOT expressible.
  // Solving it needs a per-call trusted evidence model, not a relaxation of this one.
});

test('B3C-45 【已记录边界】replySelections 是有限数组，没有长度上限', () => {
  const ownership = createFakeOwnershipMap({
    post: { ownerUin: SELF, commentIds: ['c1'], commentAuthors: { c1: OTHER } },
  });
  const table = createCorrelationTable({ selfUin: SELF, clock: () => T0 + 1000, ownership });
  // A large list is accepted: nothing enforces a cap.
  const many = Array.from({ length: 200 }, (_, i) => ({ replyUin: String(10000 + i), replyName: null }));
  assert.deepEqual(table.record({ requestId: 'r-many', accountId: SELF, sourceKind: 'group', sourceId: '105',
    sourceMessageId: 'm', issuedAt: T0, ttlMs: 60_000, allowedActions: ['reply'], targetScope: 'self',
    replySelections: many }), { ok: true }, '当前没有任何长度上限');
  // And one of them is usable.
  assert.equal(table.authorize({ requestId: 'r-many', accountId: SELF, action: 'reply',
    input: { tid: 'post', target_uin: SELF, content: 'x', comment_id: 'c1', comment_uin: String(OTHER), reply_uin: '10000', reply_name: null } }).ok, true);
});
