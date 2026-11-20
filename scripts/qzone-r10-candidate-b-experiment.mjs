// R10-1 候选 B 的隔离离线实验（假 store + 真 sqlite 各一套）。
//
// 目的只有一个：回答「把读取身份持久化到 store、跨代存活，能不能堵住换代后的
// 重放窗口（R10-1）」，以及它有哪几条前提。不接真实 QQ、不动生产配置、不改
// src/ 与 plugins/、不提交。
//
// 每条实验都打印一行 JSON，末尾打印汇总。判据写死在各段注释里，避免事后改口径。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStoreBackedReplayGuard } from './qzone-r10-candidate-b-guard.mjs';

// 每条实验打印一行 JSON。失败必须让进程非零退出，否则它不是一个门 ——
// round-9 审查员实测：把 claim 改成「同步但两次 store 调用」后 E6 的 pass 变成
// false，进程仍然 exit 0，只看退出码的人会以为全通过。
const failures = [];
const out = (label, payload) => {
  if (payload && payload.pass !== true) failures.push(label);
  console.log(JSON.stringify({ exp: label, ...payload }));
};

// ---- 假 store：语义与 src/core/qzone-store-offline.mjs 的 update(fn) 一致 ----
// update 收的是函数 fn(state) -> state；抛错即回滚；返回值不参与判定。
//
// `ops` 记录 read/update 的调用次数。这是 E6 唯一有区分力的观测量：
// 「claim 不是 async」并不能说明「检查与写入在同一个事务里」—— 一个同步但
// 先 read 再 update 的实现同样不是 thenable，却存在检查与写入之间的窗口
// （另一个进程/实例可以在同一毫秒内插进来）。只有数次数才能把两者分开：
// 单事务 = read 0 / update 1；两次调用 = read 1 / update 1。
function fakeStore(initial) {
  let state = structuredClone(initial);
  const ops = { read: 0, update: 0 };
  return {
    ops,
    read() { ops.read += 1; return structuredClone(state); },
    update(fn) {
      ops.update += 1;
      const next = fn(structuredClone(state));
      if (next === undefined) throw new TypeError('update callback returned undefined');
      state = structuredClone(next);
      return structuredClone(state);
    },
    dump: () => JSON.stringify(state),
  };
}

const BASE_STATE = { readAttempts: {}, usedOpportunities: {}, browseDay: '2026-11-11', todayBrowses: 0, audit: [] };
const ACCOUNT = 10001;
const SESSION = 'session-aaa';
const REQUEST = 'rpc-0001';
const CALL_A = 'call-alpha';
const CALL_B = 'call-beta';

// ---- E1 基本语义：认领一次，第二次判重放 ----
{
  const store = fakeStore(BASE_STATE);
  const guard = createStoreBackedReplayGuard({ store, accountId: ACCOUNT });
  const id = { sessionId: SESSION, requestId: REQUEST, callId: CALL_A };
  const first = guard.claim(id, { now: 1_760_000_000_000 });
  const peekAfter = guard.peek(id);
  const second = guard.claim(id, { now: 1_760_000_001_000 });
  out('E1_basic', {
    first, peekAfter, second,
    // 判据：第一次 ok，之后 peek true，第二次 replay 且带 claimedAt（可审计）。
    pass: first.ok === true && peekAfter === true && second.ok === false &&
      second.reason === 'replay' && second.claimedAt === 1_760_000_000_000,
    size: guard.size(),
  });
}

// ---- E2 同一 request 多个 callId：必须各自独立，不得误判重放 ----
// 同一回合同一 step 可以发多个工具调用（ledger 头注明写），一个 QQ 消息对应
// 多个 callId 是正常的。键里带 callId 就是为了这个。
{
  const store = fakeStore(BASE_STATE);
  const guard = createStoreBackedReplayGuard({ store, accountId: ACCOUNT });
  const a = guard.claim({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A }, { now: 1 });
  const b = guard.claim({ sessionId: SESSION, requestId: REQUEST, callId: CALL_B }, { now: 2 });
  const aAgain = guard.claim({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A }, { now: 3 });
  out('E2_multi_call_one_request', {
    a, b, aAgain,
    pass: a.ok === true && b.ok === true && aAgain.ok === false && guard.size() === 2,
  });
}

// ---- E3 核心：跨代重放（这就是 R10-1） ----
// 真实场景是 sourceLifetime.rotate() 换新账本、新 runtime，账本的
// usedRequests/spentCalls 随之消失。这里用「丢掉旧 guard、拿同一个 store 建
// 新 guard」精确模拟那个时刻：账本侧的记忆清零，store 侧的记忆保留。
{
  const store = fakeStore(BASE_STATE);
  const gen1 = createStoreBackedReplayGuard({ store, accountId: ACCOUNT });
  const r1 = gen1.claim({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A, generation: 'gen-1' }, { now: 100 });
  // 换代：旧账本销毁，新账本/新 guard 从同一个 store 起来
  const gen2 = createStoreBackedReplayGuard({ store, accountId: ACCOUNT });
  const r2 = gen2.claim({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A, generation: 'gen-2' }, { now: 200 });
  // 对照：换一个 turn 号（旧方案里 referenceId 含 turn，换 turn 就换键）
  const r3 = gen2.claim({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A, generation: 'gen-2', turn: 5 }, { now: 300 });
  out('E3_cross_generation_replay', {
    gen1: r1, gen2: r2, gen2_with_turn_5: r3,
    // 判据：跨代同 (session, request, call) 必须 replay；而且传入 turn 也不改变
    // 判定，证明键里确实没有 turn —— 这正是旧 referenceId 的漏洞所在。
    pass: r1.ok === true && r2.ok === false && r2.reason === 'replay' && r3.ok === false &&
      r3.reason === 'replay' && gen2.size() === 1,
  });
}

// ---- E4 未知结果永久占用：这是候选 B 的可用性代价，必须明写 ----
// claim 在派发之前落库。一旦 transport 结果未知（超时/断连），该键永久占用，
// 同一 (request, call) 不能重试。方向是 fail-closed（不给免费重试），代价是
// 一次 unknown 就废掉这个 call。
{
  const store = fakeStore(BASE_STATE);
  const guard = createStoreBackedReplayGuard({ store, accountId: ACCOUNT });
  const claimed = guard.claim({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A }, { now: 10 });
  // 模拟 transport 结果未知：不调用任何 release/settle，键保持占用
  const retryAfterUnknown = guard.claim({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A }, { now: 20 });
  // 换一个 callId（模型重发，DSH 会生成新的 callId）仍然可以读
  const newCallSameRequest = guard.claim({ sessionId: SESSION, requestId: REQUEST, callId: 'call-gamma' }, { now: 30 });
  out('E4_unknown_outcome_cost', {
    claimed, retryAfterUnknown, newCallSameRequest,
    pass: claimed.ok === true && retryAfterUnknown.ok === false && newCallSameRequest.ok === true,
    note: 'unknown 之后同 call 永久拒；同 request 换 callId 仍可用（模型重发的正常路径）',
  });
}

// ---- E5 崩溃重启：序列化重建 + 真 sqlite 双验 ----
// 内存假 store 先验证语义，再用 node:sqlite 的真 store 验证「进程重启后键还在」。
{
  const store = fakeStore(BASE_STATE);
  const guard = createStoreBackedReplayGuard({ store, accountId: ACCOUNT });
  guard.claim({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A }, { now: 50 });
  const serialized = store.dump();

  // 重启：新进程从磁盘读到同一份 JSON
  const revived = fakeStore(JSON.parse(serialized));
  const guardAfterRestart = createStoreBackedReplayGuard({ store: revived, accountId: ACCOUNT });
  const afterRestart = guardAfterRestart.claim({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A }, { now: 60 });
  out('E5a_restart_in_memory', {
    keysBefore: guard.size(), keysAfter: guardAfterRestart.size(), afterRestart,
    pass: guard.size() === 1 && guardAfterRestart.size() === 1 && afterRestart.ok === false,
  });

  // 真 sqlite
  let sqlite = { available: false };
  try {
    const { openOfflineStore } = await import('../src/core/qzone-store-offline.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'r10b-'));
    const file = join(dir, 'state.sqlite');
    const s1 = openOfflineStore(file, { state: null });
    // 用真实 store 的初始结构
    s1.update(() => ({ ...BASE_STATE }));
    const g1 = createStoreBackedReplayGuard({ store: s1, accountId: ACCOUNT });
    const beforeClose = g1.claim({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A }, { now: 70 });
    s1.close();
    const s2 = openOfflineStore(file, { state: null });
    const g2 = createStoreBackedReplayGuard({ store: s2, accountId: ACCOUNT });
    const afterReopen = g2.claim({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A }, { now: 80 });
    s2.close();
    rmSync(dir, { recursive: true, force: true });
    sqlite = {
      available: true, beforeClose, afterReopen,
      pass: beforeClose.ok === true && afterReopen.ok === false && afterReopen.reason === 'replay',
    };
  } catch (error) {
    sqlite = { available: false, error: String(error && error.message ? error.message : error) };
  }
  out('E5b_restart_sqlite', sqlite);
}

// ---- E6 原子性：为什么 claim 必须是同步的，且必须只有一个事务 ----
// 正确做法：检查与写入在同一个 store.update 回调里完成（一次事务）。
// 危害形状有两个，必须分别排除：
//   (a) 异步缝：写成「await peek() → await write()」，两个并发调用都能通过检查，
//       于是同一 call 被认领两次。用并发对照把危害跑出来。
//   (b) 同步但两次调用：「sync read() → sync update()」不是 thenable，并发在单线程
//       里也不会交错，但它在真实存储上是两个事务 —— 另一个进程/实例可以在两次
//       调用之间插进来。只看「不是 thenable」无法区分它和单事务实现。
// 因此判据必须是**计数式**的：claim 期间 store.read 必须为 0、store.update 必须为 1。
// （round-9 审查员实测：只判 thenable 时，(b) 实现 E1–E10 全绿，E6 也 pass。）
{
  const store = fakeStore(BASE_STATE);
  const guard = createStoreBackedReplayGuard({ store, accountId: ACCOUNT });

  // 首次认领：同步、单事务
  const sample = guard.claim({ sessionId: SESSION, requestId: REQUEST, callId: 'sync-probe' }, { now: 1 });
  const isThenable = sample !== null && typeof sample === 'object' && typeof sample.then === 'function';
  const firstClaimOps = { read: store.ops.read, update: store.ops.update };

  // 重放路径同样必须只走一次 update，且一个字节都不写
  const stateBeforeReplay = store.dump();
  store.ops.read = 0; store.ops.update = 0;
  const replay = guard.claim({ sessionId: SESSION, requestId: REQUEST, callId: 'sync-probe' }, { now: 2 });
  const replayOps = { read: store.ops.read, update: store.ops.update };
  const replayWroteNothing = store.dump() === stateBeforeReplay;

  // 对照 (b)：同步、但是 read + update 两次调用 —— 它能骗过「只看 thenable」
  const twoCallStore = fakeStore(BASE_STATE);
  const twoCallClaim = (identity, { now }) => {
    const key = `${ACCOUNT}\n${identity.sessionId}\n${identity.requestId}\n${identity.callId}`;
    const buckets = twoCallStore.read().usedReadKeys ?? {};
    if (Object.hasOwn(buckets, key)) return { ok: false, reason: 'replay' };
    twoCallStore.update((current) => ({
      ...current,
      usedReadKeys: { ...(current.usedReadKeys ?? {}), [key]: { claimedAt: now } },
    }));
    return { ok: true };
  };
  twoCallStore.ops.read = 0; twoCallStore.ops.update = 0;
  const twoCall = twoCallClaim({ sessionId: SESSION, requestId: REQUEST, callId: 'sync-probe' }, { now: 1 });
  const twoCallOps = { read: twoCallStore.ops.read, update: twoCallStore.ops.update };

  // 对照 (a)：带 await 缝的实现，并发三次必须出现 >1 个 accepted
  async function unsafeClaim(storeRef, identity) {
    const state = storeRef.read();
    const key = `unsafe\n${identity.callId}`;
    if (state.usedReadKeys && Object.hasOwn(state.usedReadKeys, key)) return { ok: false };
    await new Promise((resolve) => setTimeout(resolve, 1)); // 这一行就是缝
    storeRef.update((current) => ({
      ...current,
      usedReadKeys: { ...(current.usedReadKeys ?? {}), [key]: { claimedAt: 1 } },
    }));
    return { ok: true };
  }
  const unsafeStore = fakeStore(BASE_STATE);
  const unsafeResults = await Promise.all([
    unsafeClaim(unsafeStore, { callId: 'race' }),
    unsafeClaim(unsafeStore, { callId: 'race' }),
    unsafeClaim(unsafeStore, { callId: 'race' }),
  ]);
  const unsafeAccepted = unsafeResults.filter((r) => r.ok).length;

  const singleTransaction = firstClaimOps.read === 0 && firstClaimOps.update === 1;
  const replaySingleTransaction = replayOps.read === 0 && replayOps.update === 1 && replayWroteNothing;
  const twoCallIsDetectable = twoCallOps.read === 1 && twoCallOps.update === 1;

  out('E6_atomicity', {
    synchronousReturnIsThenable: isThenable,
    firstClaimStoreOps: firstClaimOps,
    replayStoreOps: replayOps,
    replayWroteNothing,
    twoCallVariantStoreOps: twoCallOps,
    twoCallVariantReturnsThenable: false,
    unsafeVariantAcceptedCount: unsafeAccepted,
    // 判据（三条同时成立）：
    //   1. 首次认领：read 0 / update 1 —— 检查与写入在同一个事务里
    //   2. 重放路径：read 0 / update 1 且状态不变 —— 被拒的尝试不写
    //   3. 对照组：并发缝必须复现危害（>1 accepted），否则这段对照不算证据
    // 注意：不再把「不是 thenable」当判据 —— 同步两次调用同样不是 thenable。
    pass: singleTransaction && replaySingleTransaction && unsafeAccepted > 1
      && twoCallIsDetectable,
    canDistinguishSingleTransactionFromTwoCalls: singleTransaction && twoCallIsDetectable,
    note: 'claim 内无 await（同步），且检查与写入同在唯一一次 store.update 里；只判 thenable 会把「同步但两次调用」误判为通过',
  });
}

// ---- E7 多实例 / 跨账号 ----
// 同一 store 目录上两个账号各自的键不得互相阻塞；同账号两个 runtime 实例共享
// 同一份键（这才是跨代生效的原因）。
{
  const store = fakeStore(BASE_STATE);
  const a1 = createStoreBackedReplayGuard({ store, accountId: 10001 });
  const a2 = createStoreBackedReplayGuard({ store, accountId: 10002 });
  const id = { sessionId: SESSION, requestId: REQUEST, callId: CALL_A };
  const r1 = a1.claim(id, { now: 1 });
  const otherAccountSameId = a2.claim(id, { now: 2 });
  const a1Again = a1.claim(id, { now: 3 });
  // 同账号的另一个实例：必须看到同一份记忆（这是跨代生效的机制）
  const a1SecondInstance = createStoreBackedReplayGuard({ store, accountId: 10001 });
  const acrossInstance = a1SecondInstance.claim(id, { now: 4 });
  out('E7_multi_account_instance', {
    r1, otherAccountSameId, a1Again, acrossInstance, totalKeys: a1.size(),
    pass: r1.ok === true && otherAccountSameId.ok === true && a1Again.ok === false &&
      acrossInstance.ok === false && a1.size() === 2,
  });
}

// ---- E8 存量迁移 ----
// 老状态没有 usedReadKeys。只能补空容器，不能从 readAttempts 反推：那里的键是
// 含 turn/step 的 digest，反推不出 (requestId, callId)，硬猜会造出假键把合法
// 读取永久拒掉。代价必须写清：迁移点之前的读，重放一次仍能通过。
{
  const legacy = { readAttempts: { 'abc123def456abc1': true }, usedOpportunities: {}, browseDay: '2026-11-11', todayBrowses: 3, audit: [] };
  const store = fakeStore(legacy);
  const guard = createStoreBackedReplayGuard({ store, accountId: ACCOUNT });
  const peekOnLegacy = guard.peek({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A });
  const claimOnLegacy = guard.claim({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A }, { now: 1 });
  const stateAfter = store.read();
  out('E8_migration', {
    peekOnLegacy, claimOnLegacy,
    keptLegacyFields: Object.hasOwn(stateAfter, 'readAttempts') && stateAfter.readAttempts['abc123def456abc1'] === true,
    usedReadKeysIsObject: typeof stateAfter.usedReadKeys === 'object' && !Array.isArray(stateAfter.usedReadKeys),
    pass: peekOnLegacy === false && claimOnLegacy.ok === true && guard.size() === 1,
    note: '迁移点之前的读取不可反推，重放一次仍会通过；这是有上界的一次性窗口',
  });
}

// ---- E9 状态腐蚀必须抛错，不得静默放行 ----
{
  const corrupted = { ...BASE_STATE, usedReadKeys: ['not', 'an', 'object'] };
  const store = fakeStore(corrupted);
  const guard = createStoreBackedReplayGuard({ store, accountId: ACCOUNT });
  let peekThrew = null;
  try { guard.peek({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A }); } catch (error) { peekThrew = String(error.message); }
  let claimThrew = null;
  try { guard.claim({ sessionId: SESSION, requestId: REQUEST, callId: CALL_A }, { now: 1 }); } catch (error) { claimThrew = String(error.message); }
  out('E9_corruption', {
    peekThrew, claimThrew,
    // 判据：两种访问都必须抛，且 store 不得被改成「空容器然后放行」。
    pass: peekThrew === 'corrupt usedReadKeys' && claimThrew === 'corrupt usedReadKeys',
  });
}

// ---- E10 键的作用域边界：它覆盖什么、不覆盖什么 ----
{
  const store = fakeStore(BASE_STATE);
  const guard = createStoreBackedReplayGuard({ store, accountId: ACCOUNT });
  const base = { sessionId: SESSION, requestId: REQUEST, callId: CALL_A };
  const variants = {
    same_key: base,
    other_session: { ...base, sessionId: 'session-bbb' },
    other_request: { ...base, requestId: 'rpc-0002' },
    other_call: { ...base, callId: 'call-zzz' },
  };
  const accepted = {};
  for (const [name, id] of Object.entries(variants)) accepted[name] = guard.claim(id, { now: 1 }).ok;
  // 同一 QQ 消息换 callId 会被放行 —— 这是刻意不覆盖的：模型重发是合法的，
  // 由 tracking 额度与 requestTurns 管，不由本守卫管。
  out('E10_key_scope', {
    accepted,
    pass: accepted.same_key === true && accepted.other_session === true &&
      accepted.other_request === true && accepted.other_call === true && guard.size() === 4,
    note: '键 = account + session + request + call；不含 turn/step/generation。不覆盖「同 request 换 callId」',
  });
}

// ---- E11 时钟与过期：没有 TTL，时钟怎么动都不释放 ----
// Codex m05450 明确要求核实「时钟/过期」。本守卫的设计是**不做任何过期**：
// `claimedAt` 只用于审计展示，判定只看键是否存在。这一段的判据是「无论时钟
// 往前、往后还是完全不动，同一个键都不能被重新认领」，因为任何 TTL 都会重开
// 一个重放窗口（丢弃即重开）。
{
  const store = fakeStore(BASE_STATE);
  const guard = createStoreBackedReplayGuard({ store, accountId: ACCOUNT });
  const id = { sessionId: SESSION, requestId: REQUEST, callId: CALL_A };
  const first = guard.claim(id, { now: 1_000 });
  const claimedAt = store.read().usedReadKeys[Object.keys(store.read().usedReadKeys)[0]].claimedAt;
  const farFuture = guard.claim(id, { now: 1_000 + 365 * 24 * 3600 * 1000 });
  const clockBackwards = guard.claim(id, { now: 0 });
  // 不传时钟是**拒绝**而不是放行：原型要求调用方给一个合法 now。
  // 这是刻意的 fail-closed —— 少了时钟就无法写出可审计的 claimedAt。
  let noClockThrew = null;
  try { guard.claim(id, {}); } catch (error) { noClockThrew = String(error.message); }
  const freshCallStillClaimable = guard.claim({ ...id, callId: CALL_B }, { now: 1_000 });
  out('E11_clock_and_expiry', {
    first, claimedAt, farFuture, clockBackwards, noClockThrew, freshCallStillClaimable,
    noTtlConfigured: !Object.hasOwn(store.read(), 'usedReadKeyTtlMs'),
    // 判据：认领后一年、时钟回退都必须 replay；不传时钟必须抛错（不放行）；
    // 而一个全新 callId 必须仍可认领（证明不是「整表被拒」）。
    pass: first.ok === true && farFuture.ok === false && farFuture.reason === 'replay' &&
      clockBackwards.ok === false && noClockThrew === 'claim needs a valid now' &&
      freshCallStillClaimable.ok === true,
    note: 'claimedAt 仅供审计展示：判定只看键存在与否；实现中没有任何 TTL/容量裁剪，因为丢弃一个键就重开一个重放窗口；缺少合法 now 时抛错而不是放行',
  });
}

// ---- E12 鉴权边界：写入 store 不是认证 ----
// Codex m05450 要求核实「鉴权边界」。这一段不测「守卫能不能被绕过」——它当然能，
// 因为守卫只是一个集合查询。它测的是「绕过方向的后果」：
//   1) 能直接写 store 的代码可以**预置键**把某个合法调用永久拒掉（拒绝服务方向）；
//   2) 能直接写 store 的代码也可以**跳过**守卫去读（它本来就在写权威状态，
//      绕过它等于绕过一切）。
// 判据不是「挡住」，而是「两种方向都必须在这里留下可复现的证据」，以免把
// 「写进 store」误说成「认证」。
{
  const store = fakeStore(BASE_STATE);
  const guard = createStoreBackedReplayGuard({ store, accountId: ACCOUNT });
  const victim = { sessionId: SESSION, requestId: 'rpc-victim', callId: 'call-victim' };

  // (1) 预置键：外部代码直接往 store 里塞一个从未发生过的键。
  const plantedKey = `${ACCOUNT}\n${victim.sessionId}\n${victim.requestId}\n${victim.callId}`;
  store.update((current) => ({
    ...current,
    usedReadKeys: { ...(current.usedReadKeys ?? {}), [plantedKey]: { claimedAt: 1, generation: null } },
  }));
  const victimClaim = guard.claim(victim, { now: 2 });
  const victimPeek = guard.peek(victim);

  // (2) 跳过守卫：外部代码完全不问守卫就决定去读。守卫看不见这件事。
  let guardWasConsulted = false;
  const originalPeek = guard.peek;
  const spy = { peek: (...args) => { guardWasConsulted = true; return originalPeek.apply(guard, args); } };
  const readWithoutAsking = () => 'read-happened'; // 不调 spy.peek 就是「跳过」
  const skipped = readWithoutAsking();

  out('E12_authz_boundary', {
    victimClaim, victimPeek, skipped, guardWasConsulted,
    // 判据：预置键必须真的让合法调用被拒（证明 DoS 方向成立），
    // 且完全不问守卫的读必须能发生（证明「不是认证」这句话不是免责声明而是事实）。
    pass: victimClaim.ok === false && victimClaim.reason === 'replay' &&
      victimPeek === true && skipped === 'read-happened' && guardWasConsulted === false,
    note: '写进 store 只表示「这个键出现过」；能写 store 的代码可预置键（DoS）或跳过查询（绕过）。守卫不认证调用方身份',
  });
}

// ---- 汇总 ----
console.log(JSON.stringify({ done: true, failures, guardSha: 'see REPORT' }));
if (failures.length > 0) process.exitCode = 1;
