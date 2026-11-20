// B2 pins: the user's 2026-11-11 decision ("empty-collection first takeover") turned into
// executable assertions, plus the fail-closed cases the R10 prototype got wrong.
//
// What the user accepted, exactly:
//   · First install creates an EMPTY replay set. A historical call that has no key may get
//     ONE extra attempt per missing key (not one system-wide, not one per restart),
//     provided it passes every other authorization check.
//   · Once a key is claimed and durably saved, that same
//     (account, session, request, call) is refused forever, including across restarts.
//   · An unknown result keeps the claim (never auto-replay).
//
// What the user did NOT accept, and what these cases therefore enforce:
//   · Clearing existing keys.
//   · Treating a LOST or CORRUPTED collection as a first install (that would silently
//     reopen every window at once).
//   · Resetting quota / pause / cooldown / audit / chat history as part of schema init.
//   · Any suggestion that this table authenticates the caller (that is B3).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REPLAY_SCHEMA_VERSION,
  REPLAY_REFUSAL,
  inspectReplayState,
  initializeReplayState,
  createReplayClaimer,
} from '../src/core/qzone-replay-claim-offline.mjs';

const ACCOUNT = 9876543210;

/** Minimal host state: something realistic enough that "init must not reset it" is testable. */
const hostState = () => ({
  enabled: false,
  reads: 7,
  writes: 3,
  accessPaused: true,
  writePaused: false,
  todayBrowses: 2,
  browseDay: '2026-11-10',
  ledger: { day: '2026-11-10', used: { post: 1, comment: 4, like: 9 }, reservations: {} },
  readAttempts: { legacyDigest: { at: 1 } },
  readOutcomes: { legacyDigest: 'success' },
  notices: [{ id: 'n1' }],
  audit: [{ id: 'auth_abc', record: { action: 'authenticate', result: 'success' } }],
  chatHistory: [{ role: 'user', text: 'hi' }],
});

function fakeStore(initial) {
  let state = structuredClone(initial);
  let updates = 0;
  return {
    read: () => structuredClone(state),
    update(fn) { updates += 1; state = fn(structuredClone(state)); return state; },
    snapshot: () => structuredClone(state),
    get updateCount() { return updates; },
  };
}

const identity = (over = {}) => ({ sessionId: 's1', requestId: 'r1', callId: 'c1', ...over });

// ── 1. first install ─────────────────────────────────────────────────────────────────
test('B2-a 首次启用：建空集合，且不改动任何其他正式状态', () => {
  const before = hostState();
  const store = fakeStore(before);

  // Before init, nothing may claim: an un-initialized store must refuse, not auto-create.
  const claimer = createReplayClaimer({ store, accountId: ACCOUNT });
  assert.deepEqual(claimer.claim(identity(), { now: 1000 }),
    { ok: false, reason: REPLAY_REFUSAL.UNINITIALIZED },
    '未初始化时不得自动建表放行');

  const init = initializeReplayState(store, { now: 1000 });
  assert.deepEqual(init, { ok: true, created: true });

  // Everything the user said must be preserved, is.
  const after = store.snapshot();
  for (const key of ['enabled', 'reads', 'writes', 'accessPaused', 'writePaused', 'todayBrowses',
    'browseDay', 'ledger', 'readAttempts', 'readOutcomes', 'notices', 'audit', 'chatHistory']) {
    assert.deepEqual(after[key], before[key], `schema 初始化不得改动 ${key}`);
  }
  assert.equal(after.replaySchema, REPLAY_SCHEMA_VERSION);
  assert.deepEqual(after.usedReadKeys, {}, '首次接管是空集合');
});

test('B2-b 重复初始化是 no-op（幂等），不得清空已有键', () => {
  const store = fakeStore(hostState());
  initializeReplayState(store, { now: 1000 });
  const claimer = createReplayClaimer({ store, accountId: ACCOUNT });
  assert.deepEqual(claimer.claim(identity(), { now: 1100 }), { ok: true });

  const again = initializeReplayState(store, { now: 1200 });
  assert.deepEqual(again, { ok: true, created: false }, '已安装后再初始化必须是 no-op');
  assert.equal(claimer.size(), 1, '已有键不得被初始化清空');
});

// ── 2. same key is refused forever ───────────────────────────────────────────────────
test('B2-c 同键第二次拒绝，且拒绝不写状态', () => {
  const store = fakeStore(hostState());
  initializeReplayState(store, { now: 1000 });
  const claimer = createReplayClaimer({ store, accountId: ACCOUNT });

  assert.deepEqual(claimer.claim(identity(), { now: 1100 }), { ok: true });
  const updatesAfterFirst = store.updateCount;

  const second = claimer.claim(identity(), { now: 1200 });
  assert.equal(second.ok, false);
  assert.equal(second.reason, REPLAY_REFUSAL.REPLAY);
  assert.equal(second.claimedAt, 1100, '拒绝时回报首次认领时刻，便于审计');
  assert.equal(store.updateCount, updatesAfterFirst + 1, '被拒的尝试仍然只有一次 update 调用');
  assert.equal(claimer.size(), 1, '被拒的尝试不得新增键');
});

test('B2-d 跨重启仍拒绝：新的 claimer 从同一 store 读回同一集合', () => {
  const store = fakeStore(hostState());
  initializeReplayState(store, { now: 1000 });
  createReplayClaimer({ store, accountId: ACCOUNT }).claim(identity(), { now: 1100 });

  // Simulate a process restart: brand-new claimer objects over the SAME persisted store.
  const afterRestart = createReplayClaimer({ store, accountId: ACCOUNT });
  const refused = afterRestart.claim(identity(), { now: 5000 });
  assert.equal(refused.ok, false, '重启后同键仍必须拒绝');
  assert.equal(refused.reason, REPLAY_REFUSAL.REPLAY);
  assert.equal(refused.claimedAt, 1100, '首次认领时刻跨重启保留');
});

test('B2-e 不同 account 是不同键：换账号不得把新账号的合法调用判成重放', () => {
  const store = fakeStore(hostState());
  initializeReplayState(store, { now: 1000 });
  const a = createReplayClaimer({ store, accountId: 111 });
  const b = createReplayClaimer({ store, accountId: 222 });

  assert.deepEqual(a.claim(identity(), { now: 1100 }), { ok: true });
  assert.deepEqual(b.claim(identity(), { now: 1200 }), { ok: true },
    '账号是键的一部分，换账号不是重放');
});

test('B2-f 同 requestId 换 callId 是合法多调用（不同键），但每个 callId 仅一次', () => {
  const store = fakeStore(hostState());
  initializeReplayState(store, { now: 1000 });
  const claimer = createReplayClaimer({ store, accountId: ACCOUNT });

  assert.deepEqual(claimer.claim(identity({ callId: 'c1' }), { now: 1100 }), { ok: true });
  assert.deepEqual(claimer.claim(identity({ callId: 'c2' }), { now: 1200 }), { ok: true },
    '同一 request 的第二个 call 是不同键，guard 不拦（其合法性由来源/额度负责）');
  assert.equal(claimer.claim(identity({ callId: 'c1' }), { now: 1300 }).ok, false, 'c1 不得第二次');
  assert.equal(claimer.size(), 2);
});

// ── 3. fail-closed on lost / corrupt collections ─────────────────────────────────────
test('B2-g 集合丢失（有标记无键）必须 fail closed，不得当首次安装重建', () => {
  const store = fakeStore(hostState());
  initializeReplayState(store, { now: 1000 });
  const claimer = createReplayClaimer({ store, accountId: ACCOUNT });
  claimer.claim(identity(), { now: 1100 });

  // Simulate an operator/crash deleting only the key collection but leaving the marker.
  const s = store.snapshot();
  delete s.usedReadKeys;
  const broken = fakeStore(s);

  const inspected = inspectReplayState(broken.read());
  assert.equal(inspected.ok, false);
  assert.equal(inspected.reason, REPLAY_REFUSAL.COLLECTION_LOST);

  const rebuilt = initializeReplayState(broken, { now: 2000 });
  assert.equal(rebuilt.ok, false, '已初始化但集合丢失时不得重建');
  assert.equal(rebuilt.reason, REPLAY_REFUSAL.COLLECTION_LOST);

  const c2 = createReplayClaimer({ store: broken, accountId: ACCOUNT });
  const refused = c2.claim(identity(), { now: 2100 });
  assert.equal(refused.ok, false, '集合丢失时必须拒绝执行，而不是放行');
  assert.equal(refused.reason, REPLAY_REFUSAL.COLLECTION_LOST);
});

test('B2-h 有键无标记（来历不明）必须拒绝，不得采纳也不得清空', () => {
  const s = hostState();
  s.usedReadKeys = { 'x\ny\nz\nw': { claimedAt: 1 } };
  const store = fakeStore(s);

  const inspected = inspectReplayState(store.read());
  assert.equal(inspected.reason, REPLAY_REFUSAL.SCHEMA_MARKER_MISSING);

  const init = initializeReplayState(store, { now: 1000 });
  assert.equal(init.ok, false, '来历不明的键不得被当成首次安装覆盖掉');
  assert.equal(init.reason, REPLAY_REFUSAL.SCHEMA_MARKER_MISSING);

  const claimer = createReplayClaimer({ store, accountId: ACCOUNT });
  assert.equal(claimer.claim(identity(), { now: 1100 }).ok, false);
  assert.equal(claimer.size(), -1, '集合不可用时 size 用 -1 表示（不是 0）');
});

test('B2-i 集合形状损坏（数组/字符串）必须拒绝', () => {
  for (const bad of [[], 'nope', 42]) {
    const s = hostState();
    s.replaySchema = REPLAY_SCHEMA_VERSION;
    s.usedReadKeys = bad;
    const store = fakeStore(s);
    const inspected = inspectReplayState(store.read());
    assert.equal(inspected.ok, false, `形状 ${JSON.stringify(bad)} 必须被拒绝`);
    assert.equal(inspected.reason, REPLAY_REFUSAL.COLLECTION_CORRUPT);
    assert.equal(createReplayClaimer({ store, accountId: ACCOUNT }).claim(identity(), { now: 1 }).ok, false);
  }
});

test('B2-j schema 版本不匹配必须拒绝（不做静默迁移）', () => {
  const s = hostState();
  s.replaySchema = REPLAY_SCHEMA_VERSION + 1;
  s.usedReadKeys = {};
  const store = fakeStore(s);
  assert.equal(inspectReplayState(store.read()).reason, REPLAY_REFUSAL.SCHEMA_MISMATCH);
  assert.equal(createReplayClaimer({ store, accountId: ACCOUNT }).claim(identity(), { now: 1 }).ok, false);
  assert.equal(initializeReplayState(store, { now: 2 }).ok, false, '版本不匹配不得被重新初始化覆盖');
});

// ── 4. unknown result keeps the claim ────────────────────────────────────────────────
test('B2-k 结果未知时占用保留：认领后崩溃/超时，同键不得再执行', () => {
  const store = fakeStore(hostState());
  initializeReplayState(store, { now: 1000 });
  const claimer = createReplayClaimer({ store, accountId: ACCOUNT });

  // Claim happens BEFORE dispatch (the caller then crashes / times out).
  assert.deepEqual(claimer.claim(identity(), { now: 1100 }), { ok: true });
  assert.equal(claimer.peek(identity()).claimed, true, '认领已落盘');

  const retry = claimer.claim(identity(), { now: 999999 });
  assert.equal(retry.ok, false, 'unknown 之后不得自动重放');
  assert.equal(retry.reason, REPLAY_REFUSAL.REPLAY);
});

// ── 5. concurrency + clock ───────────────────────────────────────────────────────────
test('B2-l 并发：同一键同时认领只有一次成功（单事务先查后写）', () => {
  const store = fakeStore(hostState());
  initializeReplayState(store, { now: 1000 });
  const claimer = createReplayClaimer({ store, accountId: ACCOUNT });

  const results = [0, 1, 2, 3, 4].map((i) => claimer.claim(identity(), { now: 1100 + i }));
  assert.equal(results.filter((r) => r.ok === true).length, 1, '恰好一次成功');
  assert.equal(results.filter((r) => r.reason === REPLAY_REFUSAL.REPLAY).length, 4);
  assert.equal(claimer.size(), 1);
});

test('B2-m 时钟只能是可信侧传入；不传或非法时拒绝（不做时间比较、不做授权）', () => {
  const store = fakeStore(hostState());
  initializeReplayState(store, { now: 1000 });
  const claimer = createReplayClaimer({ store, accountId: ACCOUNT });

  assert.equal(claimer.claim(identity()).reason, REPLAY_REFUSAL.INVALID_CLOCK);
  assert.equal(claimer.claim(identity(), { now: -1 }).reason, REPLAY_REFUSAL.INVALID_CLOCK);
  assert.equal(claimer.claim(identity(), { now: 1.5 }).reason, REPLAY_REFUSAL.INVALID_CLOCK);
  assert.equal(claimer.size(), 0, '非法时钟不得写入任何键');

  // A very old或 very new `now` must NOT matter: the decision is key existence.
  assert.deepEqual(claimer.claim(identity(), { now: 0 }), { ok: true });
  assert.equal(claimer.claim(identity(), { now: Number.MAX_SAFE_INTEGER }).ok, false,
    '时间跨度不改变判定');
});

test('B2-n 写入失败不得视为认领成功（update 抛错时 claim 必须抛出，调用方不执行）', () => {
  let state = hostState();
  initializeReplayState({ read: () => state, update: (fn) => { state = fn(state); return state; } }, { now: 1000 });

  const failing = {
    read: () => structuredClone(state),
    update() { throw new Error('disk full'); },
  };
  const claimer = createReplayClaimer({ store: failing, accountId: ACCOUNT });
  assert.throws(() => claimer.claim(identity(), { now: 1100 }), /disk full/,
    'store 写失败必须抛出，绝不能静默当成成功');
});

// ── 5b. regression: the two defects Codex reproduced ────────────────────────────────
test('B2-q 回归：只删标记与集合、留下安装痕迹时不得重新初始化（Codex 复现的缺陷1）', () => {
  const store = fakeStore(hostState());
  assert.deepEqual(initializeReplayState(store, { now: 1 }), { ok: true, created: true });
  assert.deepEqual(createReplayClaimer({ store, accountId: ACCOUNT }).claim(identity(), { now: 2 }), { ok: true });

  // Delete the marker + the collection, and keep EXACTLY the residue named in each branch.
  // The first version of this case left BOTH timestamp and installId in every branch, so the
  // three branches were actually the same scenario — that is the test weakness Codex found.
  // Now every other install field is deleted explicitly, so each branch really exercises
  // "only this residue remains".
  const ALL_INSTALL_FIELDS = ['replaySchema', 'usedReadKeys', 'replayInitializedAt', 'replayInstallId'];
  for (const residue of [['replayInitializedAt'], ['replayInstallId'], ['replayInitializedAt', 'replayInstallId']]) {
    const s = store.snapshot();
    for (const f of ALL_INSTALL_FIELDS) delete s[f];
    for (const f of residue) s[f] = store.snapshot()[f];
    // Precondition: ONLY the named residue is present.
    const present = ALL_INSTALL_FIELDS.filter((f) => Object.hasOwn(s, f)).sort();
    assert.deepEqual(present, [...residue].sort(), `前置：只允许 ${residue.join('/')} 在场，实际 ${present.join('/')}`);
    for (const f of residue) assert.equal(Object.hasOwn(s, f), true, `前置：${f} 必须在场`);
    const broken = fakeStore(s);

    const inspected = inspectReplayState(broken.read());
    assert.equal(inspected.ok, false, `留下 ${residue.join('/')} 时不得视为未安装`);
    assert.equal(inspected.reason, REPLAY_REFUSAL.COLLECTION_LOST);

    const reinit = initializeReplayState(broken, { now: 3 });
    assert.equal(reinit.ok, false, `留下 ${residue.join('/')} 时不得重新初始化`);
    assert.equal(reinit.created, false, '不得报告 created');

    const again = createReplayClaimer({ store: broken, accountId: ACCOUNT }).claim(identity(), { now: 4 });
    assert.equal(again.ok, false, '同键不得因残缺状态而再次放行');
    assert.equal(again.reason, REPLAY_REFUSAL.COLLECTION_LOST);
  }
});

test('B2-r 回归：身份元组不得因分隔符别名碰撞（Codex 复现的缺陷2）', () => {
  const store = fakeStore(hostState());
  initializeReplayState(store, { now: 1 });
  const claimer = createReplayClaimer({ store, accountId: ACCOUNT });

  // The exact pair that used to collide under newline joining.
  const a = { sessionId: 's\nx', requestId: 'r', callId: 'c' };
  const b = { sessionId: 's', requestId: 'x\nr', callId: 'c' };
  assert.equal(claimer.claim(a, { now: 2 }).reason, REPLAY_REFUSAL.INVALID_IDENTITY,
    '含换行的 id 必须被拒绝，而不是被规范化成别人的键');
  assert.equal(claimer.claim(b, { now: 3 }).reason, REPLAY_REFUSAL.INVALID_IDENTITY);
  assert.equal(claimer.size(), 0, '两个非法身份都不得占用任何键');

  // And the same for control characters / overlong ids.
  for (const bad of ['a\u0000b', 'a\rb', 'a\tb', 'x'.repeat(129)]) {
    assert.equal(claimer.claim({ sessionId: bad, requestId: 'r', callId: 'c' }, { now: 4 }).reason,
      REPLAY_REFUSAL.INVALID_IDENTITY, `非法 id ${JSON.stringify(bad.slice(0, 8))} 必须被拒`);
  }
  assert.equal(claimer.claim({ sessionId: '', requestId: 'r', callId: 'c' }, { now: 5 }).reason,
    REPLAY_REFUSAL.INVALID_IDENTITY, '空 id 必须被拒');
});

test('B2-s 合法 id 之间的元组编码不碰撞（对照：不同的合法组合得到不同的键）', () => {
  const store = fakeStore(hostState());
  initializeReplayState(store, { now: 1 });
  const claimer = createReplayClaimer({ store, accountId: ACCOUNT });

  // These all use the allowed charset and must be DISTINCT keys.
  const pairs = [
    { sessionId: 's:x', requestId: 'r', callId: 'c' },
    { sessionId: 's', requestId: 'x:r', callId: 'c' },
    { sessionId: 's', requestId: 'r', callId: 'c' },
    { sessionId: 's@x', requestId: 'r', callId: 'c' },
    { sessionId: 's', requestId: 'x@r', callId: 'c' },
  ];
  for (const p of pairs) assert.equal(claimer.claim(p, { now: 2 }).ok, true, JSON.stringify(p));
  assert.equal(claimer.size(), pairs.length, '合法组合必须各自成键，不得合并');
});
// ── 6. what this is NOT ──────────────────────────────────────────────────────────────
test('B2-o 这不是认证：能直接写 store 的代码可以预置键（拒绝服务方向）', () => {
  const store = fakeStore(hostState());
  initializeReplayState(store, { now: 1000 });

  // Anyone holding the store can insert a key that never corresponded to a real call.
  // The key format is now `JSON.stringify([accountId, sessionId, requestId, callId])`
  // (newline joining was replaced because it allowed tuple collisions).
  const key = JSON.stringify([ACCOUNT, 's1', 'r-victim', 'c-victim']);
  store.update((s) => ({ ...s, usedReadKeys: { ...s.usedReadKeys, [key]: { claimedAt: 1 } } }));

  const claimer = createReplayClaimer({ store, accountId: ACCOUNT });
  const refused = claimer.claim({ sessionId: 's1', requestId: 'r-victim', callId: 'c-victim' }, { now: 2000 });
  assert.equal(refused.ok, false, '预置键让该 callId 被永久拒绝 —— 这是拒绝服务方向');
  assert.equal(refused.reason, REPLAY_REFUSAL.REPLAY);
  // Therefore: this table proves "the key was seen", never "who wrote it". B3 owns authz.
});

test('B2-p 保留语义：没有 TTL、没有容量淘汰（size 只增）', () => {
  const store = fakeStore(hostState());
  initializeReplayState(store, { now: 1000 });
  const claimer = createReplayClaimer({ store, accountId: ACCOUNT });

  for (let i = 0; i < 20; i += 1) claimer.claim(identity({ callId: `c${i}` }), { now: 1000 + i });
  assert.equal(claimer.size(), 20);
  // Re-claim one of them: still refused, and size does not shrink or grow.
  assert.equal(claimer.claim(identity({ callId: 'c0' }), { now: 9999 }).ok, false);
  assert.equal(claimer.size(), 20, '否认不删键，也不加键');
});
