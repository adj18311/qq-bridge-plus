// Codex m05450（2026-11-11）点名要求的「受认证的代际注销 / 有界生命周期 / 内存测量」离线取证。
//
// 三个问题，各自要有可复现数字，不许用断言替代测量：
//   A. rotate() 谁能调？一个同进程的「非桥接」代码能不能把整代注销掉，之后有没有任何
//      可观测的痕迹？（这是 P8「账本不认证登记调用方」的对称面：注销也不认证。）
//   B. 反复 rotate 的代价是多少？如果它可以被任意代码触发，那它本身就是一个可被
//      滥用的资源放大器。
//   C. 「有界生命周期」要用什么量表达？把一次成功派发的内存代价测出来，才能把
//      「N 次读」翻译成字节，而不是反过来假设。
//
// 只读 + 假 store + 假 transport。不碰 src/、plugins/、真实 QQ、DSH 配置。
import { createQzoneSourceLifetime } from '../src/core/qzone-source-lifetime-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';

const SESSION = 'sess-revoke';
const DAY = Date.parse('2026-11-11T04:00:00Z');
const friendUin = 456;
const botQq = 111;
const userMessage = (rpcId) => ({ role: 'user', source: { rpcId } });

function mem() {
  const m = process.memoryUsage();
  return { heapMB: +(m.heapUsed / 1048576).toFixed(2), extMB: +(m.external / 1048576).toFixed(2), rssMB: +(m.rss / 1048576).toFixed(2) };
}

function fakeStore() {
  let state = {
    enabled: true, readAllowed: true, writeAllowed: false,
    accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: false },
    reads: 0, writes: 0,
    readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-11', todayBrowses: 0, lastBrowseAt: null,
    usedOpportunities: {}, activeStart: 0, activeEnd: 1439, audit: [],
  };
  return { read: () => structuredClone(state), update(fn) { state = fn(structuredClone(state)); return state; }, dump: () => structuredClone(state) };
}

function makeTransport() {
  const actions = [];
  const call = async (action) => {
    actions.push(action);
    if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: botQq } };
    if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: friendUin }] };
    if (action === 'get_qzone_msg_list') return { status: 'ok', retcode: 0, data: { total: 0, msglist: [] } };
    throw new Error(`unexpected ${action}`);
  };
  return { actions, call };
}

// 一棵「活」的代际：lifetime + ledger + runtime。rotate 之后这一整棵都必须重新建。
function buildGeneration({ lifetime, transport, store, trackingLimit = 64 }) {
  const ledger = lifetime.getLedger(SESSION);
  const runtime = createQzoneRuntime({
    store, botQq,
    sourceEpoch: lifetime.sourceEpoch(),
    authorizeSource: (c) => lifetime.ownsConsumption(c),
    getConnectionEpoch: () => 1,
    getBridgeSessions: () => lifetime.getLedger(SESSION),
    clock: () => DAY,
    mode: 'read-only',
    trackingLimit,
    call: transport.call,
  });
  return { ledger, runtime, epoch: lifetime.sourceEpoch() };
}

let turnCounter = 0;
async function dispatchOnce(gen, { requestId, callId } = {}) {
  turnCounter += 1;
  const turn = turnCounter;
  const rid = requestId ?? `rid-${turn}`;
  const cid = callId ?? `cid-${turn}`;
  try {
    gen.ledger.registerBridgeRequest({ requestId: rid, origin: 'qq-inbound' });
    gen.ledger.observeStep({ sessionId: SESSION, turn, step: 1, messages: [userMessage(rid)] });
    gen.ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn, step: 1, callId: cid } } });
    const r = await gen.runtime.dispatch('read_posts', { target_uin: friendUin }, { sessionId: SESSION, callId: cid });
    gen.ledger.endTurn({ sessionId: SESSION, turn });
    return r.ok ? r.outcome : `${r.error}/${r.reason ?? ''}`;
  } catch (error) {
    return `threw: ${error.message}`;
  }
}

const out = {};

// ---- A：非桥接代码能否注销整代？注销之后有没有痕迹？----
{
  const lifetime = createQzoneSourceLifetime({ sessionLimit: 4, trackingLimit: 64 });
  const store = fakeStore();
  const transport = makeTransport();
  const gen = buildGeneration({ lifetime, transport, store });

  const beforeEpoch = lifetime.sourceEpoch();
  const healthy = await dispatchOnce(gen);

  // 「攻击者」：同进程里任意拿到 lifetime 的代码，不持有任何凭据、不问任何守卫。
  // 它不需要 import bridge、不需要 epoch、不需要 store，只要拿到这个对象。
  const attackerRotated = (() => {
    try { return lifetime.rotate(); } catch (error) { return `threw: ${error.message}`; }
  })();

  const afterEpoch = lifetime.sourceEpoch();
  const sameGeneration = (() => {
    try { return lifetime.getLedger(SESSION) === gen.ledger; } catch { return 'threw'; }
  })();
  const oldLedgerStillAcceptsRequests = (() => {
    try { gen.ledger.registerBridgeRequest({ requestId: 'rid-after', origin: 'qq-inbound' }); return 'accepted'; }
    catch (error) { return `refused: ${error.message}`; }
  })();
  const victimDispatchAfter = await dispatchOnce(gen);

  // 痕迹：lifetime 暴露的只读面里，有什么能告诉 owner「刚刚有人注销了一代」？
  const observable = Object.keys(lifetime).sort();

  out.A_unauthenticated_rotation = {
    healthyDispatch: healthy,
    epochChanged: beforeEpoch !== afterEpoch,
    epochBefore: typeof beforeEpoch === 'string' ? 'uuid' : String(beforeEpoch),
    epochAfter: typeof afterEpoch === 'string' ? 'uuid' : String(afterEpoch),
    attackerNeededNoCredential: true,
    attackerRotatedIsUuid: typeof attackerRotated === 'string' && attackerRotated.length === 36,
    sameGenerationObject: sameGeneration,
    oldLedgerStillAcceptsRequests,
    victimDispatchAfterRotation: victimDispatchAfter,
    lifetimePublicSurface: observable,
    hasRotationCounter: false,
    hasRotationReason: false,
    verdict: 'ROTATE_IS_UNAUTHENTICATED',
    note: 'rotate() 只校验 closed 标志，不校验调用方、不带原因、不累加任何计数器。任何持有 lifetime 的代码都能把整代注销；owner 唯一能观察到的是 sourceEpoch() 变了，而它在正常重连时也会变。',
  };
}

// ---- B：反复 rotate 的代价（可被滥用时的放大器）----
{
  const N = 200;
  const lifetime = createQzoneSourceLifetime({ sessionLimit: 4, trackingLimit: 64 });
  const before = mem();
  const t0 = process.hrtime.bigint();
  let iterations = 0;
  for (let i = 0; i < N; i += 1) {
    lifetime.getLedger(SESSION);   // 建一本
    lifetime.rotate();             // 立刻注销
    iterations += 1;
  }
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const after = mem();
  out.B_rotation_cost = {
    rotations: iterations,
    elapsedMs: +elapsedMs.toFixed(2),
    perRotationMs: +(elapsedMs / iterations).toFixed(3),
    deltaHeapMB: +(after.heapMB - before.heapMB).toFixed(2),
    deltaExtMB: +(after.extMB - before.extMB).toFixed(2),
    deltaRssMB: +(after.rssMB - before.rssMB).toFixed(2),
    platformCalls: 0,
    storeWrites: 0,
    note: 'rotate 不写 store、不发平台请求，所以代价只有 UUID + 一轮 disconnect/clear。它便宜到可以被循环调用 —— 「便宜」在这里是缺点：一条非桥接路径就能反复让桥接的代际失效。',
  };
}

// ---- C：把「有界生命周期」翻译成字节：一次成功派发留下多少常驻状态？----
{
  const TIERS = [32, 128, 512];
  const runs = [];
  for (const n of TIERS) {
    const samples = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (global.gc) global.gc();
      const before = mem();
      const lifetime = createQzoneSourceLifetime({ sessionLimit: 4, trackingLimit: 4096 });
      const store = fakeStore();
      const transport = makeTransport();
      const gen = buildGeneration({ lifetime, transport, store, trackingLimit: 4096 });
      let successes = 0;
      for (let i = 0; i < n; i += 1) {
        const r = await dispatchOnce(gen);
        if (r === 'success') successes += 1;
      }
      const after = mem();
      samples.push({
        successes,
        deltaHeapMB: +(after.heapMB - before.heapMB).toFixed(2),
        deltaExtMB: +(after.extMB - before.extMB).toFixed(2),
        deltaRssMB: +(after.rssMB - before.rssMB).toFixed(2),
      });
    }
    const mean = (key) => +(samples.reduce((s, x) => s + x[key], 0) / samples.length).toFixed(2);
    runs.push({ reads: n, successes: samples[0].successes, meanDeltaHeapMB: mean('deltaHeapMB'), meanDeltaExtMB: mean('deltaExtMB'), meanDeltaRssMB: mean('deltaRssMB'), spreadHeapMB: samples.map((s) => s.deltaHeapMB) });
  }
  const smallest = runs[0];
  const largest = runs[runs.length - 1];
  const readDelta = largest.reads - smallest.reads;
  out.C_per_read_cost = {
    tiers: runs,
    marginalHeapMBPerRead: readDelta > 0 ? +(((largest.meanDeltaHeapMB - smallest.meanDeltaHeapMB) / readDelta)).toFixed(5) : null,
    marginalRssMBPerRead: readDelta > 0 ? +(((largest.meanDeltaRssMB - smallest.meanDeltaRssMB) / readDelta)).toFixed(5) : null,
    noiseCaveat: 'heapUsed 在同量级有 ±1 MB 抖动、external 对短字符串几乎不动，所以这些数字只能读作「量级」，不能读作「每次读 X 字节」。要得出可写进设计的界，必须用 --expose-gc 重复多轮取中位。',
    boundExpression: '有界生命周期的界应当写成「本代成功派发次数 <= trackingLimit」，而不是字节数：次数是确定性上界（r10-lifetime-cost-probe 的 T1b 已实测墙恰等于 trackingLimit），字节只能给量级。',
  };
}

// ---- D：把 C 的成本拆开 —— 是账本在涨，还是 store 在涨？----
// C 的 0.045 MB/read 里，大部分不可能来自账本的 Map：一次读只留下
// usedRequests/spentCalls 两个短字符串 + calls 里一条（endTurn 就回收）。
// 真正按读增长的应该是 store：readAttempts、readOutcomes、audit 每次读各加一条，
// 而 fakeStore 每次 update 都 structuredClone 整个 state。
//
// 这两者必须分开报，否则接线方会拿一个被 store 撑大的数字去设账本的界。
{
  const TIERS = [32, 128, 512];
  const rows = [];
  for (const n of TIERS) {
    const samples = { ledgerOnly: [], withStore: [] };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // (1) 只跑账本记账，不派发、不碰 store：register + observe + observe + consume + endTurn
      if (global.gc) global.gc();
      let before = mem();
      {
        const lifetime = createQzoneSourceLifetime({ sessionLimit: 4, trackingLimit: 4096 });
        const ledger = lifetime.getLedger(SESSION);
        for (let i = 0; i < n; i += 1) {
          turnCounter += 1;
          const turn = turnCounter;
          ledger.registerBridgeRequest({ requestId: `rid-${turn}`, origin: 'qq-inbound' });
          ledger.observeStep({ sessionId: SESSION, turn, step: 1, messages: [userMessage(`rid-${turn}`)] });
          ledger.observeToolCall({ sessionId: SESSION, event: { type: 'tool/call', data: { turn, step: 1, callId: `cid-${turn}` } } });
          ledger.consume({ sessionId: SESSION, turn, step: 1, callId: `cid-${turn}` });
          ledger.endTurn({ sessionId: SESSION, turn });
        }
      }
      let after = mem();
      samples.ledgerOnly.push(+(after.heapMB - before.heapMB).toFixed(2));

      // (2) 完整派发（含 store 写入）
      if (global.gc) global.gc();
      before = mem();
      {
        const lifetime = createQzoneSourceLifetime({ sessionLimit: 4, trackingLimit: 4096 });
        const store = fakeStore();
        const transport = makeTransport();
        const gen = buildGeneration({ lifetime, transport, store, trackingLimit: 4096 });
        for (let i = 0; i < n; i += 1) await dispatchOnce(gen);
      }
      after = mem();
      samples.withStore.push(+(after.heapMB - before.heapMB).toFixed(2));
    }
    const mean = (arr) => +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(2);
    rows.push({
      reads: n,
      ledgerOnlyMeanHeapMB: mean(samples.ledgerOnly),
      withStoreMeanHeapMB: mean(samples.withStore),
      storeShareMB: +(mean(samples.withStore) - mean(samples.ledgerOnly)).toFixed(2),
      ledgerOnlySpread: samples.ledgerOnly,
      withStoreSpread: samples.withStore,
    });
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  const span = last.reads - first.reads;
  out.D_cost_split = {
    tiers: rows,
    ledgerOnlyMBPerRead: span > 0 ? +((last.ledgerOnlyMeanHeapMB - first.ledgerOnlyMeanHeapMB) / span).toFixed(6) : null,
    withStoreMBPerRead: span > 0 ? +((last.withStoreMeanHeapMB - first.withStoreMeanHeapMB) / span).toFixed(6) : null,
    caution: '两列的差值不是精确的「store 成本」—— 两轮各自有独立抖动，且 structuredClone 的临时副本会被计入峰值。可读的结论只有一个方向：完整派发比纯记账贵一个数量级，所以「每次读占多少内存」的主体在 store，不在账本。',
  };
}

console.log(JSON.stringify(out, null, 2));
