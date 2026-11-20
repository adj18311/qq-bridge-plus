// R10-1 候选 B：在真实 rotate() 路径上验证「跨代重放被堵住」。
//
// 隔离实验，不是生产接线：
//   - src/ 与 plugins/ 一个字节都不改；
//   - 把 src/core 整目录**分别**复制到 %TEMP%\r10c\control 与 %TEMP%\r10c\guarded，
//     只在 guarded 副本里插入守卫调用。两个副本必须是不同的 URL：Node 按 URL 缓存
//     ESM 模块，同一个文件路径先后写两份内容只会拿到第一次 import 的那份。
//   - 账本、reader、transport、sourceLifetime 全部是真实模块，只有 store 与
//     QQ transport 是假的；
//   - 判据写死：control 必须重现 R10-1（跨代重放 success、平台调用 1→2），
//     guarded 必须 origin-unverified 且平台调用数不涨，同时同代全新读仍成功。

import { mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = fileURLToPath(new URL('../src/core/', import.meta.url));
const GUARD_SRC = fileURLToPath(new URL('./qzone-r10-candidate-b-guard.mjs', import.meta.url));
const ROOT = join(tmpdir(), 'r10c');

const out = (label, payload) => console.log(JSON.stringify({ exp: label, ...payload }));

function materialize(variant, { withGuard }) {
  const core = join(ROOT, variant);
  mkdirSync(core, { recursive: true });
  for (const name of readdirSync(SRC)) {
    if (name.endsWith('.mjs')) copyFileSync(join(SRC, name), join(core, name));
  }
  copyFileSync(GUARD_SRC, join(core, 'qzone-r10-candidate-b-guard.mjs'));

  const wiringPath = join(core, 'qzone-runtime-wiring.mjs');
  const original = readFileSync(wiringPath, 'utf8');

  const IMPORT_ANCHOR = "import { isOriginLedgerConsumption } from './qzone-origin-ledger-offline.mjs';";
  const GUARD_ANCHOR = '  const sessionCallCounts = new Map();';
  const CLAIM_ANCHOR = '        // From here the charge is kept for a GENUINE read attempt:';

  let text = original;
  if (withGuard) {
    for (const anchor of [IMPORT_ANCHOR, GUARD_ANCHOR, CLAIM_ANCHOR]) {
      if (!text.includes(anchor)) throw new Error(`anchor missing: ${anchor.slice(0, 40)}`);
    }
    text = text.replace(IMPORT_ANCHOR,
      `${IMPORT_ANCHOR}\nimport { createStoreBackedReplayGuard } from './qzone-r10-candidate-b-guard.mjs';`);
    text = text.replace(GUARD_ANCHOR,
      `  const replayGuard = createStoreBackedReplayGuard({ store, accountId: botQq });\n${GUARD_ANCHOR}`);
    text = text.replace(CLAIM_ANCHOR,
      `        {\n` +
      `          const claim = replayGuard.claim({\n` +
      `            sessionId: context.sessionId, requestId: consumption.requestId, callId: context.callId,\n` +
      `          }, { now: now() });\n` +
      `          if (!claim.ok) return refuse('origin-unverified', 'policy');\n` +
      `        }\n` +
      CLAIM_ANCHOR);
  }
  const patched = text !== original;
  if (withGuard !== patched) throw new Error(`patch state mismatch for ${variant}`);
  writeFileSync(wiringPath, text);
  return pathToFileURL(join(core, 'x.mjs')).href.replace(/x\.mjs$/, '');
}

// `notices` 必须是数组：`settleOfflineRead`（src/core/qzone-settlement-offline.mjs:72）
// 在结算时校验 `Array.isArray(state.notices)`。
// `reads` / `writes` 必须是**非负安全整数**：`nextFailureState`
// （src/core/qzone-policy-offline.mjs:26-29）在每次结算时都校验它们。
// 任一缺失都抛错，reader 的 catch 把它变成 `unknown` —— 表面「读成功但没内容」。
const INITIAL = {
  audit: [], readAttempts: {}, readOutcomes: {}, usedOpportunities: {}, notices: [],
  reads: 0, writes: 0,
  browseDay: '2026-11-12', todayBrowses: 0, lastBrowseAt: null,
  enabled: true, readAllowed: true, writeAllowed: false, accessPaused: false, writePaused: false,
  activeStart: 420, activeEnd: 1380,
  tools: { read_posts: true, read_comments: false, publish: false, comment: false, reply: false, like: false },
};

const DAY = Date.parse('2026-11-12T04:00:00Z');
const BOT = 10001;
const FRIEND = 20002;
const SESSION = 'session-aa';

function fakeStore(initial) {
  let state = structuredClone(initial);
  return {
    read: () => structuredClone(state),
    update(fn) {
      const next = fn(structuredClone(state));
      if (next === undefined) throw new TypeError('update returned undefined');
      state = structuredClone(next);
      return state;
    },
    dump: () => structuredClone(state),
  };
}

function makeTransport() {
  const calls = [];
  return {
    calls,
    platform: () => calls.filter((c) => c === 'get_qzone_msg_list').length,
    async get_login_info() { calls.push('get_login_info'); return { status: 'ok', retcode: 0, data: { user_id: BOT } }; },
    async get_friend_list() { calls.push('get_friend_list'); return { status: 'ok', retcode: 0, data: [{ user_id: FRIEND }] }; },
    async get_qzone_msg_list() {
      calls.push('get_qzone_msg_list');
      return { status: 'ok', retcode: 0, data: { total: 1, msglist: [
        { tid: 'p1', content: 'hello from the friend', time: Math.floor(DAY / 1000) - 3600 },
      ] } };
    },
  };
}

// `getConnectionEpoch` 必须返回非负整数（wiring 用 `Number.isSafeInteger` 校验；
// 返回字符串会被判成「未连接」并让整个实例永久 invalidated）。
// `sourceEpoch` 才是 lifetime 的 UUID 字符串，两者不能混用。
function makeGeneration(createQzoneRuntime, { lifetime, store, transport, connectionEpoch }) {
  const epoch = lifetime.sourceEpoch();
  const ledger = lifetime.getLedger(SESSION);
  const runtime = createQzoneRuntime({
    store, botQq: BOT,
    getConnectionEpoch: () => connectionEpoch.value,
    sourceEpoch: epoch,
    authorizeSource: () => true,
    call: (name, params) => transport[name](params),
    // `getBridgeSessions(sessionId)` 必须直接返回账本对象本身（wiring 里紧接着
    // 调 `ledger.peekCall` / `ledger.consume`），不是数组。
    getBridgeSessions: (sessionId) => lifetime.getLedger(sessionId),
    clock: () => DAY,
    mode: 'enabled',
    trackingLimit: 8,
  });
  return { epoch, ledger, runtime };
}

// 一次「登记 + 观察 + 工具调用」。step 必须从 1 开始连续；一个 turn 只能用
// 一个 requestId；回合之间必须 endTurn，否则下一回合被 `turn !== activeTurn` 判失续。
function prepare(ledger, { turn, step, requestId, callId }) {
  ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  const stepOk = ledger.observeStep({
    sessionId: SESSION, turn, step, messages: [{ role: 'user', source: { rpcId: requestId } }],
  });
  const callOk = ledger.observeToolCall({
    sessionId: SESSION,
    event: { type: 'tool/call', data: { turn, step, callId, name: 'qzone_read_posts' } },
  });
  return { stepOk, callOk };
}

const read = (runtime, callId) =>
  runtime.dispatch('read_posts', { target_uin: FRIEND }, { sessionId: SESSION, callId });
const describe = (r) => (r && typeof r === 'object' ? (r.ok === false ? `err:${r.error}` : `ok:${r.outcome}`) : String(r));

async function scenario({ variant, withGuard, label }) {
  const coreUrl = materialize(variant, { withGuard });
  const { createQzoneRuntime } = await import(`${coreUrl}qzone-runtime-wiring.mjs`);
  const { createQzoneSourceLifetime } = await import(`${coreUrl}qzone-source-lifetime-offline.mjs`);

  const store = fakeStore(INITIAL);
  const transport = makeTransport();
  const lifetime = createQzoneSourceLifetime();
  const connectionEpoch = { value: 1 };

  // 第 1 代：真实成功读
  const gen1 = makeGeneration(createQzoneRuntime, { lifetime, store, transport, connectionEpoch });
  prepare(gen1.ledger, { turn: 1, step: 1, requestId: 'rpc-1', callId: 'call-1' });
  const first = await read(gen1.runtime, 'call-1');
  gen1.ledger.endTurn({ sessionId: SESSION, turn: 1 });
  const platformAfterFirst = transport.platform();

  // 真实换代：旧账本 retire/clear，新代新 UUID、新账本、新 runtime
  const newEpoch = lifetime.rotate();
  connectionEpoch.value += 1;
  const gen2 = makeGeneration(createQzoneRuntime, { lifetime, store, transport, connectionEpoch });

  // 新代里重新登记同一个 requestId / callId（伪造登记或迟到事件的形状）
  prepare(gen2.ledger, { turn: 5, step: 1, requestId: 'rpc-1', callId: 'call-1' });
  const replay = await read(gen2.runtime, 'call-1');
  gen2.ledger.endTurn({ sessionId: SESSION, turn: 5 });
  const platformAfterReplay = transport.platform();

  // 对照：新代全新的合法读必须不受影响
  prepare(gen2.ledger, { turn: 6, step: 1, requestId: 'rpc-2', callId: 'call-2' });
  const legit = await read(gen2.runtime, 'call-2');

  return {
    label,
    epochChanged: gen1.epoch !== newEpoch,
    firstRead: describe(first),
    firstPosts: first?.posts?.length ?? null,
    replayRead: describe(replay),
    legitRead: describe(legit),
    platformAfterFirst,
    platformAfterReplay,
    reproducesR10_1: first?.outcome === 'success' && replay?.outcome === 'success' && platformAfterReplay > platformAfterFirst,
    closesR10_1: replay?.ok === false && replay?.error === 'origin-unverified' && platformAfterReplay === platformAfterFirst,
    legitStillWorks: legit?.outcome === 'success',
  };
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const control = await scenario({ variant: 'control', withGuard: false, label: 'control' });
out('A_control_no_guard', control);

const guarded = await scenario({ variant: 'guarded', withGuard: true, label: 'guarded' });
out('B_guarded', guarded);

// 收尾：副本删除，主树核对
rmSync(ROOT, { recursive: true, force: true });
const mainText = readFileSync(join(SRC, 'qzone-runtime-wiring.mjs'), 'utf8');
const closed = control.reproducesR10_1 === true && guarded.closesR10_1 === true && guarded.legitStillWorks === true;
out('C_isolation', {
  tempRemoved: !existsSync(ROOT),
  mainBytes: Buffer.byteLength(mainText),
  mainHasGuard: mainText.includes('replayGuard'),
  verdict: closed ? 'R10_1_CLOSED_BY_CANDIDATE_B' : 'INCONCLUSIVE',
});
