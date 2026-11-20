// E6 的判据不够严 —— 独立复现并给出真正有区分力的断言。
//
// round-9 审查员指出：`scripts/qzone-r10-candidate-b-experiment.mjs` 的 E6 用的是
//   pass: isThenable === false && unsafeAccepted > 1
// 而「两次 store 调用、中间不 await」的实现同样满足它（`e6CanDistinguish: false`）。
// 也就是说 E6 证明的是「claim 不是 async」，不是「claim 在同一个事务里先查后写」。
//
// 这个探针给出真正能区分三者的判据：在 claim() 期间数 store 的 read / update 次数。
//   - 单一事务（正确）：read 0 次、update 1 次 —— 检查与写入都在 update 回调里
//   - 两次调用（不足）：read 1 次、update 1 次 —— 检查在 read 里，写入在 update 里
//   - 带 await 缝（危害）：并发下 accepted > 1
//
// 只读：假 store，无网络、无凭据、无真实 QQ。
import { createStoreBackedReplayGuard } from './qzone-r10-candidate-b-guard.mjs';

const BASE_STATE = Object.freeze({ notices: [], reads: 0, writes: 0, audit: [], usedReadKeys: {} });
const ACCOUNT = 10001;
const SESSION = 'sess-e6';
const REQUEST = 'rpc-e6';

// Counts store operations so "one transaction" becomes measurable instead of implied.
function countingStore(initial) {
  let state = structuredClone(initial);
  const ops = { reads: 0, updates: 0 };
  return {
    ops,
    read() { ops.reads += 1; return structuredClone(state); },
    update(fn) { ops.updates += 1; state = fn(structuredClone(state)); return structuredClone(state); },
    dump() { return structuredClone(state); },
  };
}

const out = {};

// ---------------------------------------------------------------------------
// 1. 出厂实现：claim 期间必须 read 0 / update 1。
// ---------------------------------------------------------------------------
{
  const store = countingStore(BASE_STATE);
  const guard = createStoreBackedReplayGuard({ store, accountId: ACCOUNT });
  store.ops.reads = 0; store.ops.updates = 0;
  const result = guard.claim({ sessionId: SESSION, requestId: REQUEST, callId: 'c-e6' }, { now: 100 });
  out.shipped = { result, readsDuringClaim: store.ops.reads, updatesDuringClaim: store.ops.updates };

  // A replay must ALSO be a single update and must write nothing.
  const before = store.dump();
  store.ops.reads = 0; store.ops.updates = 0;
  const replay = guard.claim({ sessionId: SESSION, requestId: REQUEST, callId: 'c-e6' }, { now: 200 });
  out.shippedReplay = {
    result: replay,
    readsDuringClaim: store.ops.reads,
    updatesDuringClaim: store.ops.updates,
    stateUnchanged: JSON.stringify(before) === JSON.stringify(store.dump()),
  };
}

// ---------------------------------------------------------------------------
// 2. 两次调用变体（检查在 read 里、写入在 update 里，中间不 await）。
//    它满足 E6 原来的判据，但期间 read 1 / update 1 —— 这就是判据不够的证据。
// ---------------------------------------------------------------------------
{
  const store = countingStore(BASE_STATE);
  const guard = createStoreBackedReplayGuard({ store, accountId: ACCOUNT });
  const twoCallClaim = (identity, { now }) => {
    // 同步，返回的不是 thenable —— 因此旧的 E6 判据会判它「通过」。
    const key = `${ACCOUNT}\n${identity.sessionId}\n${identity.requestId}\n${identity.callId}`;
    if (Object.hasOwn(store.read().usedReadKeys, key)) return { ok: false, reason: 'replay' };
    store.update((current) => ({ ...current, usedReadKeys: { ...current.usedReadKeys, [key]: { claimedAt: now } } }));
    return { ok: true };
  };
  void guard;
  store.ops.reads = 0; store.ops.updates = 0;
  const result = twoCallClaim({ sessionId: SESSION, requestId: REQUEST, callId: 'c-e6' }, { now: 100 });
  out.twoCallVariant = {
    result,
    readsDuringClaim: store.ops.reads,
    updatesDuringClaim: store.ops.updates,
    returnsThenable: false,
  };
}

// ---------------------------------------------------------------------------
// 3. 带 await 缝的变体：并发三次必须出现 >1 个 accepted（把危害真的跑出来）。
// ---------------------------------------------------------------------------
{
  const store = countingStore(BASE_STATE);
  const unsafeClaim = async (identity) => {
    const key = `${ACCOUNT}\n${identity.sessionId}\n${identity.requestId}\n${identity.callId}`;
    if (Object.hasOwn(store.read().usedReadKeys, key)) return { ok: false };
    await new Promise((resolve) => { setTimeout(resolve, 1); });
    store.update((current) => ({ ...current, usedReadKeys: { ...current.usedReadKeys, [key]: { claimedAt: 1 } } }));
    return { ok: true };
  };
  const identity = { sessionId: SESSION, requestId: REQUEST, callId: 'c-race' };
  const results = await Promise.all([unsafeClaim(identity), unsafeClaim(identity), unsafeClaim(identity)]);
  out.awaitVariant = { accepted: results.filter((r) => r.ok).length };
}

// ---------------------------------------------------------------------------
// 4. 结论：哪个断言真正能把三者分开。
// ---------------------------------------------------------------------------
out.discriminatingAssertion = {
  rule: 'claim() 期间 store.read 必须为 0、store.update 必须为 1',
  shippedSatisfies: out.shipped.readsDuringClaim === 0 && out.shipped.updatesDuringClaim === 1,
  twoCallVariantSatisfies: out.twoCallVariant.readsDuringClaim === 0,
  awaitVariantConcurrencyShowsHazard: out.awaitVariant.accepted > 1,
  oldE6CriterionWouldPassTwoCallVariant: out.twoCallVariant.readsDuringClaim === 1
    && out.twoCallVariant.returnsThenable === false,
};
out.verdict = {
  e6OldCriterionInsufficient: out.discriminatingAssertion.oldE6CriterionWouldPassTwoCallVariant,
  shippedIsSingleTransaction: out.discriminatingAssertion.shippedSatisfies,
  replayWritesNothing: out.shippedReplay.updatesDuringClaim === 1 && out.shippedReplay.stateUnchanged,
};

console.log(JSON.stringify(out, null, 2));
