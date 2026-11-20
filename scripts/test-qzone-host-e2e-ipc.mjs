// I3 · 两进程链路端到端（隔离环境，假 transport）——把 I1（跨进程审批通道）与 I2（插件侧可信来
// 源装配）真的接起来跑一遍完整链路。
//
// ⚠️ 这份文件证明什么、不证明什么（先读这段，别把它读成生产结论）
// ---------------------------------------------------------------
//   · 「两进程」在这里是两条**逻辑侧**：bridge 侧（真 http listener + 真 broker）与插件侧（真
//     http client + 真 plugin host runtime）。它们之间走的是**真实 loopback socket**（node:http
//     监听 127.0.0.1 的临时端口，客户端用 undici fetch 真发请求），但**仍然在同一个 OS 进程里**。
//     所以：本文件证明「真实 socket 上的链路成立」，**不证明**两个真实 OS 进程之间的链路成立，
//     也**不足以**定生产库选型，更**不构成生产可用结论**（生产库的锁竞争/迁移/恢复/权限、真
//     fork 双进程、真实 QQ/OneBot、真实人类操作员，全部未覆盖）。
//   · 所有断言都在**测试条件**下、**隔离环境**中完成：临时 SQLite（os.tmpdir()）、临时端口、
//     每次运行新铸的内存令牌。不读 config.json / 凭据 / ACL，不碰 state/ 下任何真实文件。
//
// 真实对象（一条链路上一个都没 mock）
// -----------------------------------
//   · 真 SQLite 临时库（openOfflineStore）+ 真 B2 重放集合（initializeReplayState）；
//   · 真来源账本（createQzoneOriginLedger，由 plugin host runtime 的 sourceLifetime.getLedger 铸出）；
//   · 真插件侧装配（createQzonePluginHostRuntime）+ 它组合出的真 createQzoneRuntime；
//   · 真审批 broker（createQzoneProductionApprovalBroker → 真 approval 队列 + 真
//     createQzoneApprovalAuditRecorder + 真写入审计 sink）；
//   · 真跨进程通道（createQzoneApprovalIpcServer / createQzoneApprovalIpcClient / protocol 模块）；
//   · 真操作授权器（runtime 内部的 createQzoneOperationAuthorizer）、真 B2 claim、真写路径
//     （createOfflineWritePath，含 reserve → 终审 → transport）、真 approved-comment 组合
//     （createQzoneWriteAuthorizer）、真 OneBot 写契约（buildQzoneOnebotWriteRequest）、
//     真写入审计 sink（createQzoneWriteAudit）。
//
// 夹具（只有这三样，且都不参与策略判断）
// --------------------------------------
//   · send       —— 假 transport：记录 payload 并回答 {ok:true}（或按用例抛错），一次真实
//                   OneBot 请求都不发；
//   · call       —— 假读传输：只记录，被调用就算失败（写链不该碰它）；
//   · clock      —— 钉死的可信时钟（live.now），让配额日/审批 TTL/间隔规则可复现。
//   另有一处**故意注入的故障**（不是把被测对象换成 mock）：B9 的入口篡改包装器，只在客户端入口
//   把 operation.inputDigest 换成与正文矛盾的值，用来问「摘要不符的帧能不能问到 bridge」。
//
// 每条断言失败意味着哪一段断了，都写在断言消息里。

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import {
  createQzoneOriginLedger,
  isOriginLedgerConsumption,
} from '../src/core/qzone-origin-ledger-offline.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { createQzoneProductionApprovalBroker } from '../src/core/qzone-production-wiring.mjs';
import { createQzonePluginHostRuntime } from '../src/core/qzone-plugin-host-runtime.mjs';
import { createQzoneApprovalIpcServer } from '../src/core/qzone-approval-ipc-server.mjs';
import { createQzoneApprovalIpcClient } from '../src/core/qzone-approval-ipc-client.mjs';
import {
  QZONE_APPROVAL_IPC_PATH,
  serializeQzoneApprovalRequestFrame,
} from '../src/core/qzone-approval-ipc-protocol.mjs';
import { _writeAuditInputDigest } from '../src/core/qzone-write-audit-broker-adapter-offline.mjs';

const NOW = Date.parse('2026-11-16T04:00:00Z');
const ACCOUNT = 123;                       // botQq（正的安全整数）
const SESSION = 's1';
const REQUEST = 'request-1';
const EPOCH = 'e1';                        // sourceEpoch
const OPERATOR = 'console-session-abc';    // 服务端会话 id（charset 满足 console 与 sink 的规则）
const COMMENT_INPUT = Object.freeze({ tid: 'post-1', target_uin: 456, content: 'nice post' });
const PUBLISH_INPUT = Object.freeze({ content: 'hello world', ugc_right: 1 });
const REPLY_INPUT = Object.freeze({
  tid: 'post-1', target_uin: 456, content: 'replying to you', comment_id: 'cm-1', comment_uin: 789,
});
const LIKE_INPUT = Object.freeze({ tid: 'post-1', target_uin: 456 });

/** 每次运行现铸、只在内存里：从不落盘、从不打印、从不参与断言。 */
const TOKEN = randomBytes(32).toString('base64url');

/** 真 store 需要的完整初始状态（策略门、配额账本、审计数组）。 */
function initialState(now = NOW) {
  return {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 10, comment: 25, like: 30 },
    ledger: { day: beijingDay(now), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
    reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    browseDay: beijingDay(now), todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [], notices: [],
  };
}

/**
 * 一个隔离世界：真临时库 + 真 bridge 侧（broker + listener）+ 真插件侧（client + host runtime）。
 *
 * 清理用一个 t.after 按固定顺序做完（host.teardown → client.close → server.close → broker.close
 * → store.close → 删临时目录），最后再**复查目录真的没了**：删除失败必须是测试失败，不能被吞掉。
 */
async function world(t, options = {}) {
  const {
    withWiring = true,
    mode = 'enabled',
    sendImpl,
    approveOperationImpl,
    serverTimeoutMs = 5000,
    clientTimeoutMs = 5000,
  } = options;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-host-e2e-ipc-'));
  const owned = { store: null, broker: null, server: null, client: null, host: null };
  t.after(async () => {
    try { owned.host?.teardown(); } catch { /* 已拆过 */ }
    try { await owned.client?.close(); } catch { /* 已关 */ }
    try { await owned.server?.close(); } catch { /* 已关 */ }
    try { owned.broker?.close(); } catch { /* 已关 */ }
    try { owned.store?.close(); } catch { /* 已关 */ }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows 句柄短暂占用 */ }
      if (!fs.existsSync(dir)) break;
    }
    assert.equal(fs.existsSync(dir), false, '临时目录必须真的删掉（否则隔离环境在泄漏）：' + dir);
  });

  owned.store = openOfflineStore(path.join(dir, 'state.db'), initialState(NOW));
  const store = owned.store;
  assert.equal(initializeReplayState(store, { now: NOW }).ok, true,
    '前提：B2 重放集合已由真实 initializeReplayState 初始化（否则每次写都会 uninitialized 拒绝）');

  const live = { now: NOW, epoch: 8 };
  const calls = [];
  const sent = [];
  // 夹具 1：读传输。写链永远不该调用它 —— 一旦调用就是测试失败信号，所以它先记录再抛。
  const call = async (action, params) => {
    calls.push([action, params]);
    throw new Error('读传输在写链里被调用了：这意味着链路串到了另一条路上');
  };
  // 夹具 2：假 send。记录 payload，默认答 {ok:true}。
  const send = sendImpl ?? (async (payload) => { sent.push(payload); return { ok: true }; });

  // ── BRIDGE 侧：真审批 broker（真 recorder + 真写入审计 sink，sink 落在同一个 state.writeAudit）─
  const bridge = createQzoneProductionApprovalBroker({ store, clock: () => live.now });
  owned.broker = bridge.broker;
  const { broker, audit } = bridge;

  // 透传观察器：把 server 收到的 operation **原样**转交真 broker，不做任何判断、不改写、不另存裁决。
  // 它存在的唯一目的是给「这次询问确实到了 bridge 侧」留下可断言的证据。
  const bridgeSideAsks = [];
  const serverBroker = Object.freeze({
    approveOperation(operation) {
      bridgeSideAsks.push(operation);
      return broker.approveOperation(operation);
    },
  });

  owned.server = await createQzoneApprovalIpcServer({
    broker: serverBroker, token: TOKEN, clock: () => live.now, timeoutMs: serverTimeoutMs,
  });
  const server = owned.server;
  const origin = 'http://127.0.0.1:' + server.port;

  // ── 插件侧：真通道客户端 ────────────────────────────────────────────────────────────────────
  owned.client = createQzoneApprovalIpcClient({
    origin, token: TOKEN, clock: () => live.now, timeoutMs: clientTimeoutMs,
  });
  const client = owned.client;
  // 默认把真客户端的 approveOperation 交给授权器；用例可以注入「只在入口篡改」的包装器（B9）。
  const approveOperation = approveOperationImpl ?? ((operation) => client.approveOperation(operation));

  // ── 插件侧：真装配（createQzonePluginHostRuntime → 内部真 createQzoneRuntime）─────────────────
  const writePath = (transport) => createOfflineWritePath({ store, clock: () => live.now, transport });
  const hostOptions = {
    store, botQq: ACCOUNT, sourceEpoch: EPOCH, clock: () => live.now, call,
    getConnectionEpoch: () => live.epoch,
    approveOperation,
    replayStore: store,
    mode,
  };
  if (withWiring) {
    // 写能力只能从这里来；audit 与 broker 是**同一个** sink，所以三行审计共处一条 trail。
    hostOptions.writeWiring = Object.freeze({
      send, writePath, source: 'qq', actions: ['publish', 'comment', 'reply', 'like'], audit,
    });
  }
  owned.host = createQzonePluginHostRuntime(hostOptions);
  const host = owned.host;

  // ── 驱动真实账本位置（插件侧唯一合法的来源）─────────────────────────────────────────────────
  // 一个 (turn, step) 只能被一个 bridge requestId 引用；同一 step 上可以挂多个 callId，
  // 每个 callId 是一个独立的可消费位置（qzone-origin-ledger-offline.mjs:237-294）。
  let armed = false;
  const ledgerFor = () => host.sourceLifetime.getLedger(SESSION);
  function arm() {
    const ledger = ledgerFor();
    ledger.registerBridgeRequest({ requestId: REQUEST, origin: 'qq-inbound' });
    assert.equal(ledger.observeStep({
      sessionId: SESSION, turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: REQUEST } }],
    }), true, '前提：真实 pre-step（turn 1 / step 1）已被真实账本观察');
    armed = true;
    return ledger;
  }
  function position(callId) {
    const ledger = armed ? ledgerFor() : arm();
    assert.equal(ledger.observeToolCall({
      sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId } },
    }), true, '前提：真实 tool/call ' + callId + ' 已被真实账本记录');
    return Object.freeze({ sessionId: SESSION, callId });
  }

  /** 等到 bridge 侧 broker 真的握着一张票据（或超时，超时本身就是链路断了的证据）。 */
  async function waitForTickets(expected = 1, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pending = broker.listPending();
      if (pending.length >= expected) return pending;
      if (Date.now() > deadline) {
        throw new Error('等待 bridge 侧 broker 收到审批票据超时：链路断在「插件侧 authorizer → 客户端 → '
          + '真实 http → listener → broker」这一段（bridge 侧实际只收到 '
          + bridgeSideAsks.length + ' 次询问）');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  const rows = () => (store.read().writeAudit ?? []).map((row) => ({ ...row }));
  const claimedKeys = () => Object.keys(store.read().usedReadKeys ?? {});
  const dispatchAuditRows = () => (store.read().audit ?? []).filter((e) => String(e.id).startsWith('dsp_'));

  return {
    dir, store, live, calls, sent, broker, audit, server, client, host, origin,
    bridgeSideAsks, ledger: ledgerFor, arm, position, waitForTickets, rows, claimedKeys, dispatchAuditRows,
    /** 操作员点击：只有 bridge 侧能这么做，插件侧没有任何入口。 */
    decide(operation, approved) {
      return broker.decide({
        authorizationId: operation.authorizationId,
        inputDigest: operation.inputDigest,
        approved,
      }, { operator: OPERATOR });
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// A. 完整链路：真实来源 → dispatch → 真实 http → bridge broker → 操作员批准 → 写路径 → 假 send
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('I3-A 完整链路（隔离环境）：三行审计同 authorizationId/inputDigest，写路径真的走到 send', async (t) => {
  assert.equal(typeof fetch, 'function', '前提：客户端用 node 自带 fetch 走真实 http');
  const w = await world(t);
  assert.equal(w.server.address, '127.0.0.1', '★ 监听地址必须是回环字面量（端口是临时端口）');
  assert.ok(w.server.port > 0, '★ 真实 listener 必须绑到一个真实端口');

  // ── A1 真实账本：registerBridgeRequest → observeStep → observeToolCall → consume ──────────
  const probeIds = w.position('c-probe');
  const ledger = w.ledger();
  const probePeek = ledger.peekCall('c-probe');
  assert.deepEqual(probePeek, { turn: 1, step: 1 },
    '★★ 账本必须自己记录这个 callId 的 (turn,step)：来源证据来自账本，不是调用方自报');
  const probe = ledger.consume({ sessionId: SESSION, turn: probePeek.turn, step: probePeek.step, callId: probeIds.callId });
  assert.equal(isOriginLedgerConsumption(probe), true,
    '★★★ consume 必须给出真实品牌 consumption（WeakMap 身份）；断了就意味着来源根本不是账本签发的');
  assert.equal(ledger.ownsConsumption(probe), true, '★★ 且这个 consumption 属于这个账本对象');
  assert.equal(probe.sessionId, SESSION);
  assert.equal(probe.requestId, REQUEST, '★★ requestId 来自 registerBridgeRequest 的真实登记');
  assert.equal(probe.origin, 'qq-inbound');

  // ── A2 dispatch 一次 comment 写 ─────────────────────────────────────────────────────────
  // ★ 来源必须是真实宿主数据（本期必加断言）：dispatch 上下文的 sessionId/callId 并不是随便传的
  // 两个字符串 —— callId 的位置证据 (turn, step) 由真实账本自己记录（observeToolCall 写下、
  // peekCall 读出），没有这条证据时同一个 dispatch 会被拒（见 I3-C11）。
  const ids = w.position('c-main');
  assert.deepEqual(w.ledger().peekCall(ids.callId), { turn: 1, step: 1 },
    '★★★ dispatch 之前，账本必须自己握有这个 callId 的 (turn,step)：'
    + '来源是账本记录的事实，不是调用方自报的字符串');
  assert.equal(ids.sessionId, SESSION, '★ sessionId 是宿主 sourceLifetime 铸出账本的那个 session');
  const pendingDispatch = w.host.dispatch('comment', COMMENT_INPUT, ids);

  // ── A3 审批真的跨过 socket 到达 bridge 侧 broker ────────────────────────────────────────
  const tickets = await w.waitForTickets(1);
  assert.equal(tickets.length, 1, '★★ bridge 侧必须恰好握着一张票据');
  assert.equal(w.bridgeSideAsks.length, 1,
    '★★★ 询问必须经过真实 listener 到达 bridge 侧；为 0 意味着插件侧根本没有上网（或通道被打断）');
  assert.equal(w.bridgeSideAsks[0].authorizationId, tickets[0].authorizationId,
    '★★ bridge 侧看到的与 broker 手里的必须是同一张票据');
  assert.equal(w.bridgeSideAsks[0].action, 'comment', '★★ 跨过通道的是这次写操作本身');
  assert.equal(w.bridgeSideAsks[0].sessionId, SESSION);
  assert.equal(w.bridgeSideAsks[0].inputDigest, tickets[0].inputDigest,
    '★★ 通道两端的摘要必须是同一个（否则审批与执行描述的不是同一份正文）');
  assert.deepEqual(w.bridgeSideAsks[0].input, { tid: 'post-1', target_uin: 456, content: 'nice post' });
  assert.equal(Object.hasOwn(w.bridgeSideAsks[0], 'consumption'), false,
    '★★ 品牌 consumption 不能跨进程：线上帧里不存在这个字段');

  // 操作员在 bridge 侧点「批准」——插件侧没有任何决定入口。
  assert.equal(w.decide(tickets[0], true), true,
    '★★ 决定必须被真实 recorder 成功记录（记不下来就不允许批准）');

  // ── A4 写路径：reserve → claim → intent → send → result ─────────────────────────────────
  const result = await pendingDispatch;
  assert.equal(result.ok, true, '★★★ 完整链路必须成功（失败信息见 result）：' + JSON.stringify(result));
  assert.equal(result.outcome, 'success');
  assert.equal(result.sent, true);
  assert.equal(result.stage, 'transport');
  assert.equal(Object.hasOwn(result, 'auditFailed'), false, '★ 审计正常时不得带 auditFailed');

  assert.equal(w.sent.length, 1, '★★★ 假 send 必须恰好被调用一次（reserve/claim/intent 各一次，send 一次）');
  assert.deepEqual(w.sent[0], {
    action: 'comment_qzone',
    params: { tid: 'post-1', target_uin: 456, content: 'nice post' },
  }, '★★ 发给假 send 的必须是平台请求本身（参数未被改写）');
  assert.equal(w.calls.length, 0, '★★★ 读传输 0 次：整条链没有任何真实 QQ/OneBot 请求');

  // 配额与 B2 claim 的副作用（写路径自己的账）
  const afterState = w.store.read();
  assert.equal(afterState.ledger.used.comment, 1, '★★ 配额记账发生了一次');
  assert.equal(afterState.ledger.used.post, 0);
  assert.equal(w.claimedKeys().length, 1, '★★ B2 四元组被 durable claim 了一次');
  // 位置确实被这次 dispatch 消耗掉了：证明来源不是自报，而是真实账本位置。
  assert.equal(w.ledger().peekCall('c-main'), null,
    '★★★ dispatch 之后该 callId 的位置必须已被账本消费（来源是真实账本，不是调用方字符串）');
  assert.deepEqual(w.host.status().ledgers.sessions, [SESSION],
    '★★ 只有真实 getLedger 铸出的那一个账本：dispatch 不会凭空造账本');
  assert.equal(w.dispatchAuditRows().length, 1,
    '★ runtime 自己的 dispatch 审计（state.audit）记了一条 success');

  // ── A5 三行审计：approval / intent / result 同 authorizationId、同 inputDigest ────────────
  const auditRows = w.rows();
  assert.deepEqual(auditRows.map((row) => row.stage), ['approval', 'intent', 'result'],
    '★★★ 生命周期必须是 approval → intent → result（实际 ' + JSON.stringify(auditRows.map((r) => r.stage)) + '）'
    + '：顺序错了意味着审批行不是 decide 时写的，或 intent 不在 send 之前');
  const authIds = new Set(auditRows.map((row) => row.authorizationId));
  assert.equal(authIds.size, 1,
    '★★★ 三行必须共用同一个 authorizationId（实际 ' + JSON.stringify([...authIds]) + '）：'
    + '不唯一说明审批行与执行行描述的不是同一次授权');
  const digests = new Set(auditRows.map((row) => row.inputDigest));
  assert.equal(digests.size, 1,
    '★★★ 三行必须共用同一个 inputDigest（实际 ' + JSON.stringify([...digests]) + '）：'
    + '不唯一说明「批准的是 A、尝试发送的是 B」');
  assert.match([...digests][0], /^[0-9a-f]{64}$/, '★ digest 是 sha256 形状');
  assert.notEqual([...digests][0], [...authIds][0],
    '★★ 四元组 id 与正文摘要必须是两个不同的值（不许塌成一列）');
  assert.match([...authIds][0], /^[0-9a-f]{32}$/, '★ authorizationId 是 B2 四元组摘要');
  assert.notEqual([...authIds][0], tickets[0].authorizationId,
    '★ 审计 id 不是票据 UUID：插件侧的 randomUUID 不下发到 bridge 侧审计里');
  assert.equal(auditRows[0].decision, 'approved', '★★ approval 行如实记录批准');
  assert.equal(auditRows[0].operatorSessionId, OPERATOR, '★★ operator 来自 decide 的认证会话参数');
  assert.equal(auditRows[1].outcome, null, '★ intent 行不携带 outcome（决定 ≠ 结果）');
  assert.equal(auditRows[2].outcome, 'success', '★★ result 行写的是写路径的真实分类');
  for (const row of auditRows) {
    assert.equal(row.accountId, ACCOUNT);
    assert.equal(row.sessionId, SESSION);
    assert.equal(row.requestId, REQUEST);
    assert.equal(row.callId, 'c-main');
    assert.equal(row.action, 'comment');
  }
  // 正文永不落盘：整份 state 序列化里都不该出现评论正文。
  assert.equal(JSON.stringify(w.store.read()).includes('nice post'), false,
    '★★★ 正文不得进入任何持久化字段（审计 sink 只有摘要）');

  assert.equal(w.host.teardown(), true, '★ 首次 teardown 报告一次');
  assert.equal(w.host.teardown(), false, '★★ 幂等');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// B6. 操作员拒绝 ⇒ 不发送
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('I3-B6 操作员 decide(approved:false) ⇒ send 0 次，且留下 rejected 的审批行', async (t) => {
  const w = await world(t);
  const ids = w.position('c-reject');
  const pending = w.host.dispatch('comment', COMMENT_INPUT, ids);
  const [ticket] = await w.waitForTickets(1);
  assert.equal(w.decide(ticket, false), true, '★★ 拒绝也必须先被 durable 记录，记录成功才允许结案');

  const result = await pending;
  assert.equal(result.ok, false, '★★★ 被拒绝的写不得成功：' + JSON.stringify(result));
  assert.equal(result.reason, 'not-authorized', '★ 拒绝词汇来自写组合（prepare 拿不到票据）');
  assert.equal(result.stage, 'authorize');
  assert.equal(w.sent.length, 0, '★★★ send 0 次：审批没通过就绝不允许发出');
  assert.equal(w.calls.length, 0, '★★ 读传输 0 次');
  assert.deepEqual(w.claimedKeys(), [], '★★ 未批准不得占用 B2 四元组');
  assert.equal(w.store.read().ledger.used.comment, 0, '★★ 未批准不得花配额（prepare 在写路径之前）');

  const auditRows = w.rows();
  assert.deepEqual(auditRows.map((row) => row.stage), ['approval'],
    '★★ 只有 approval 一行：没有 intent/result，因为什么都没尝试发送');
  assert.equal(auditRows[0].decision, 'rejected', '★★ 审计如实记录「被拒绝」，不是「没发生」');
  assert.equal(auditRows[0].operatorSessionId, OPERATOR);
  w.host.teardown();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// B7. 超时 / 迟到审批 / 票据自然过期 ⇒ 都不发送
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('I3-B7 服务端超时 + 迟到 decide(approved:true) + 票据自然过期 ⇒ 全部 send 0 次', async (t) => {
  // 服务端预算故意远小于客户端预算：询问会真的到达 bridge 侧（bridgeSideAsks 记录），
  // 但监听器在预算到期时回答 approved:false，客户端就此收敛为 false。
  const w = await world(t, { serverTimeoutMs: 500, clientTimeoutMs: 5000 });

  // (1) 第一次写：超时，操作员一直不点。
  const ids1 = w.position('c-timeout-1');
  const first = await w.host.dispatch('comment', COMMENT_INPUT, ids1);
  assert.equal(w.bridgeSideAsks.length, 1,
    '★★ 询问必须真的到达 bridge 侧（超时是「bridge 侧不回答」，不是「请求没发出去」）');
  assert.equal(first.ok, false, '★★★ 超时必须收敛为失败：' + JSON.stringify(first));
  assert.equal(first.reason, 'not-authorized', '★★ 客户端拿到 false ⇒ 授权器拿不到票据');
  assert.equal(w.sent.length, 0, '★★★ 超时场景 send 0 次');
  assert.equal(w.calls.length, 0);

  // 超时**不取消** broker 里的票据：操作员控制台仍然看得到它（这是通道的有意设计）。
  const pendingAfterTimeout = w.broker.listPending();
  assert.equal(pendingAfterTimeout.length, 1, '★★ 服务端超时不得取消 broker 票据');

  // (2) ★ 迟到的人工审批不得导致发送。
  //
  // ⚠️ 这里**实测**的返回值是 true，必须连语义一起读，不能读成「批准了这次写」：
  //   · decide() 的返回值在真实 broker 里是「决定被接受并 durable 记录、票据按该裁决结案」
  //     （qzone-operation-approval-console.mjs:65-85：recordDecision 返回 strict true 后
  //     finish(id, approved) 成功即 true；PW-1/PW-2 断言的也是这个语义）；
  //   · 它**不是**「这次写被放行」：dispatch 早已以 not-authorized 收尾，作者器根本没铸出票据，
  //     没有任何东西在等这张票（服务端 askBroker 的 Promise.race 已经输给了超时）。
  // 真正要守住的两条是下面两句断言：send 仍然 0 次、dispatch 结果仍然不是成功。
  // 如果哪天 decide() 的 true 变成了「可以补发」，那才是缺陷 —— 本用例就是那条探针。
  const late = pendingAfterTimeout[0];
  assert.equal(w.decide(late, true), true,
    '★ 实测：迟到 decide 返回 true = 「决定已记录、票据已结案」（PW-1/PW-2 同一语义），'
    + '不等于「这次写被批准发送」');
  assert.equal(w.sent.length, 0,
    '★★★ 迟到批准绝不能补发出写：dispatch 已经以 false 收尾，没有任何东西会重放它');
  assert.equal(first.ok, false, '★★ 迟到批准不得把已结束的 dispatch 改判为成功');
  const rowsAfterLate = w.rows();
  assert.deepEqual(rowsAfterLate.map((row) => row.stage), ['approval'],
    '★★★ 迟到批准只留下审批行；没有 intent/result 行 —— 因为确实什么都没尝试发送');
  assert.equal(rowsAfterLate[0].decision, 'approved',
    '★★ 审计如实记录「批准了但没执行」：这是可读的事实，不是伪造的成功');
  assert.equal(w.store.read().ledger.used.comment, 0, '★★ 迟到批准同样不得花配额');
  assert.deepEqual(w.claimedKeys(), [],
    '★★★ 迟到批准同样不得占用 B2 四元组：写路径从未被进入（claim 在写路径内部）');

  // (3) 第二次写：超时后让票据**自然过期**，再迟到 decide 应当直接被拒。
  const ids2 = w.position('c-timeout-2');
  const second = await w.host.dispatch('comment', COMMENT_INPUT, ids2);
  assert.equal(second.ok, false, '★★ 第二次同样以失败收尾');
  assert.equal(w.sent.length, 0);
  const stillPending = w.broker.listPending();
  assert.equal(stillPending.length, 1, '前提：第二张票据仍在队列里');
  // 推进可信时钟越过票据的 expiresAt：broker 的 purgeExpired 会以「不批准」结案。
  w.live.now += 30001;
  assert.equal(w.broker.listPending().length, 0,
    '★★ 票据到期后 broker 必须清空它（自然过期 = 不批准，不是挂起）');
  assert.equal(w.decide(stillPending[0], true), false,
    '★★★ 票据已经过期 ⇒ 迟到的 decide 必须被拒（返回 false），不能事后批准');
  assert.equal(w.sent.length, 0, '★★★ 自然过期 + 迟到 decide 之后仍然 send 0 次');
  assert.deepEqual(w.rows().map((row) => row.stage), ['approval'],
    '★★ 过期的票据不会写第二条审批行（decide 被拒，什么都没落）');
  w.host.teardown();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// B8. 断连：server 提前 close ⇒ 客户端 false ⇒ 不发送
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('I3-B8 断连（listener 先关）⇒ 客户端 false ⇒ send 0 次，且 bridge 侧零询问', async (t) => {
  const w = await world(t);
  // 证明这条通道**真的**是跨 socket 的：把监听器关掉，插件侧就不可能再拿到批准。
  await w.server.close();
  const ids = w.position('c-disconnected');
  const result = await w.host.dispatch('comment', COMMENT_INPUT, ids);

  assert.equal(result.ok, false, '★★★ 断连必须收敛为失败：' + JSON.stringify(result));
  assert.equal(result.reason, 'not-authorized');
  assert.equal(w.bridgeSideAsks.length, 0,
    '★★★ bridge 侧一次询问都没收到：证明审批确实要过 socket，插件侧没有任何本地捷径');
  assert.equal(w.sent.length, 0, '★★★ 断连场景 send 0 次');
  assert.equal(w.calls.length, 0);
  assert.equal(w.broker.listPending().length, 0, '★★ 没有票据入队');
  assert.deepEqual(w.rows(), [], '★★ 没有审批行：连审批都没发生过');
  assert.deepEqual(w.claimedKeys(), [], '★★ 断连不得占用 B2 四元组');
  w.host.teardown();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// B9. digest 不符 ⇒ 拒绝，不发送
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('I3-B9 digest 与正文不符 ⇒ 两端都拒（400 / false），send 0 次', async (t) => {
  // 故障注入：只在客户端入口把 inputDigest 换成与正文矛盾的值。这不是把被测对象换成 mock ——
  // 真客户端、真协议、真 listener、真 broker 全部在位，只是问它们「摘要自相矛盾的帧能过去吗」。
  let tamper = true;
  const w = await world(t, {
    approveOperationImpl: (operation) => (tamper
      ? w.client.approveOperation({ ...operation, inputDigest: 'b'.repeat(64) })
      : w.client.approveOperation(operation)),
  });

  const ids = w.position('c-digest');
  const result = await w.host.dispatch('comment', COMMENT_INPUT, ids);
  assert.equal(result.ok, false, '★★★ 摘要不符必须收敛为失败：' + JSON.stringify(result));
  assert.equal(result.reason, 'not-authorized');
  assert.equal(w.sent.length, 0, '★★★ send 0 次');
  assert.equal(w.bridgeSideAsks.length, 0,
    '★★★ 摘要与正文矛盾的帧连 socket 都不该开（协议层在自己这边就拒）');
  assert.equal(w.calls.length, 0);
  assert.deepEqual(w.rows(), [], '★★ 没有审批行：broker 从未看到这个操作');

  // 同一个要求也要在**服务端**成立：构造自洽但摘要错误的原始帧，直接 POST 到真实 listener。
  const fixtureInput = { tid: 'post-1', target_uin: 456, content: 'nice post' };
  const genuine = {
    accountId: ACCOUNT, sessionId: SESSION, requestId: 'r-raw', callId: 'c-raw',
    sourceEpoch: EPOCH, connectionEpoch: 8, origin: 'qq-inbound', action: 'comment',
    input: fixtureInput, inputDigest: _writeAuditInputDigest(fixtureInput),
    authorizationId: 'auth-e2e-raw-1', expiresAt: w.live.now + 30000,
  };
  const body = serializeQzoneApprovalRequestFrame(genuine);
  assert.equal(typeof body, 'string', '前提：正常帧可以被协议序列化');

  const post = async (frame) => {
    const answer = await fetch(w.origin + QZONE_APPROVAL_IPC_PATH, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(frame),
    });
    const text = await answer.text();
    return { status: answer.status, text };
  };

  // (a) 信封与正文同时改成同一个伪造摘要：两端「一致」，但与正文不符 ⇒ 仍必须拒。
  const bothBad = JSON.parse(body);
  bothBad.inputDigest = 'c'.repeat(64);
  bothBad.operation.inputDigest = 'c'.repeat(64);
  const a = await post(bothBad);
  assert.equal(a.status, 400, '★★★ 服务端必须 400（摘要与正文不符 ⇒ 帧非法）');
  assert.equal(a.text.includes('"approved":false'), true, '★ 拒绝帧必须明写 approved:false');

  // (b) 只改信封、不改 operation：信封与 operation 不一致 ⇒ 也必须拒。
  const envelopeBad = JSON.parse(body);
  envelopeBad.inputDigest = 'd'.repeat(64);
  const b = await post(envelopeBad);
  assert.equal(b.status, 400, '★★ 信封 id 与 operation 不一致同样 400');

  assert.equal(w.broker.listPending().length, 0, '★★★ 两个伪造帧都没有进入 broker 队列');
  assert.equal(w.sent.length, 0, '★★★ 伪造帧更不可能触发发送');
  assert.deepEqual(w.rows(), [], '★★ 伪造帧没有留下任何审批行');

  // 控制组：把篡改关掉，同一条链路立刻恢复（证明上面的失败来自摘要，而不是环境坏了）。
  tamper = false;
  const good = w.position('c-digest-control');
  const pendingGood = w.host.dispatch('comment', COMMENT_INPUT, good);
  const [ticket] = await w.waitForTickets(1);
  assert.equal(w.decide(ticket, true), true);
  const success = await pendingGood;
  assert.equal(success.ok, true, '★★ 控制组必须成功，否则上面对照无效：' + JSON.stringify(success));
  assert.equal(w.sent.length, 1, '★ 控制组恰好一次 send');
  w.host.teardown();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// B10. 未知结果不重试
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('I3-B10 send 抛错 ⇒ 结果 unknown 且只调用一次（不重发）', async (t) => {
  // ⚠️ 「只发一次」这条性质**不依赖审批通道**：通道在拿到裁决后就退场了，发送次数由写路径 +
  // durable B2 claim 决定（reserveWrite 无回滚、claim 无删除路径、写路径没有重试分支）。这里的
  // 断言是端到端地确认：即使结果未知，链路也不会因为「不知道」而再发一次。
  const w = await world(t, {
    sendImpl: async (payload) => {
      w.sent.push(payload);
      throw new Error('transport exploded');
    },
  });
  const ids = w.position('c-unknown');
  const pending = w.host.dispatch('comment', COMMENT_INPUT, ids);
  const [ticket] = await w.waitForTickets(1);
  assert.equal(w.decide(ticket, true), true);

  const result = await pending;
  assert.equal(result.ok, true, '★ 写路径把「异常」分类为 unknown，而不是失败：' + JSON.stringify(result));
  assert.equal(result.outcome, 'unknown', '★★★ 抛错 != 没发生：必须如实是 unknown');
  assert.equal(result.reason, 'unknown-outcome');
  assert.equal(result.sent, true, '★ sent 表示「已交给 send」，此处确实交过一次');
  assert.equal(result.quotaConsumed, true, '★ 配额已花且不回滚（没有退款路径）');
  assert.equal(w.sent.length, 1, '★★★ 不得重试：send 恰好被调用一次');
  assert.equal(w.calls.length, 0);

  const rows = w.rows();
  assert.deepEqual(rows.map((row) => row.stage), ['approval', 'intent', 'result'],
    '★★ 三行仍然齐全（result 的 outcome 是 unknown）');
  assert.equal(rows[2].outcome, 'unknown', '★★★ 结果行写的是「不知道」，不是「成功」');
  assert.equal(new Set(rows.map((row) => row.authorizationId)).size, 1, '★ 仍然是一次授权');
  assert.equal(w.claimedKeys().length, 1, '★★ B2 四元组只被占用一次（重发会需要第二次 claim）');
  // 等一小会儿，确认没有「稍后重试」的尾巴。
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(w.sent.length, 1, '★★★ 之后也没有补发：链路没有重试引擎');
  w.host.teardown();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// C11. 来源不可伪造：自报 sessionId/callId 但没有真实账本位置
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('I3-C11 自报 sessionId/callId 不走真实账本 ⇒ origin-unverified，send 0 次', async (t) => {
  const w = await world(t);
  assert.equal(w.host.status().ledgers.count, 0, '前提：一开始一个账本都没有');

  // (a) 一个宿主从未铸过账本的 session：dispatch 不能顺手造一个。
  const unknownSession = await w.host.dispatch('comment', COMMENT_INPUT,
    { sessionId: 's-self-reported', callId: 'c-self-reported' });
  assert.deepEqual(unknownSession, { ok: false, error: 'origin-unverified' },
    '★★★ 自报的 session 必须被拒：来源不能由调用方声明');
  assert.equal(w.host.status().ledgers.count, 0,
    '★★★ dispatch 绝不为自报 session 铸账本（I2 的信任分割：唯一的铸账本入口是 sourceLifetime.getLedger）');

  // (b) 有真实账本（由 host 的 sourceLifetime 铸出），但 callId 从未被观察过：没有位置 ⇒ 没有来源。
  const warm = w.position('c-warm');            // 真实位置：registerBridgeRequest + observeStep + observeToolCall
  const ledger = w.ledger();
  assert.deepEqual(ledger.peekCall('c-never-observed'), null, '前提：这个 callId 确实没有任何位置');
  const unobserved = await w.host.dispatch('comment', COMMENT_INPUT,
    { sessionId: SESSION, callId: 'c-never-observed' });
  assert.deepEqual(unobserved, { ok: false, error: 'origin-unverified' },
    '★★★ 自报的 callId 必须被拒：账本没有它的 (turn,step) 证据');
  assert.deepEqual(w.host.status().ledgers.sessions, [SESSION], '★ 只有真实账本那一个');
  assert.equal(w.bridgeSideAsks.length, 0, '★★ 被拒的 dispatch 连审批都不该问');
  assert.equal(w.sent.length, 0, '★★★ send 0 次');
  assert.equal(w.calls.length, 0);
  assert.deepEqual(w.rows(), [], '★★ 没有审批行');
  assert.ok(warm, '★ 真实位置对象存在（下面控制组用同一 session 的另一个位置）');

  // 控制组：同一 session、另一个被真实账本观察到的 callId，必须放行到 send。
  const ids = w.position('c-real');
  const pending = w.host.dispatch('comment', COMMENT_INPUT, ids);
  const [ticket] = await w.waitForTickets(1);
  assert.equal(w.decide(ticket, true), true);
  const ok = await pending;
  assert.equal(ok.ok, true, '★★ 控制组：真实位置必须放行：' + JSON.stringify(ok));
  assert.equal(w.sent.length, 1);
  w.host.teardown();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// C12. 另一个账本签发的 consumption ⇒ 拒绝
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('I3-C12 外来账本签发的 consumption ⇒ origin-unverified，send 0 次', async (t) => {
  const w = await world(t);
  // 让宿主先持有本 session 的真实账本，好让下面 (b) 的拒绝落在 ownsConsumption 上而不是更早的门。
  const owned = w.ledger();
  assert.deepEqual(w.host.status().ledgers.sessions, [SESSION]);

  /** 用真模块造一个「别人的」账本，并在它上面走完真实登记/观察/消费。 */
  const foreignFor = (sessionId, tag) => {
    const foreign = createQzoneOriginLedger({ sessionId, epoch: EPOCH });
    foreign.registerBridgeRequest({ requestId: 'r-' + tag, origin: 'qq-inbound' });
    assert.equal(foreign.observeStep({
      sessionId, turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'r-' + tag } }],
    }), true, '前提：外来账本自己观察了 pre-step');
    assert.equal(foreign.observeToolCall({
      sessionId, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c-' + tag } },
    }), true, '前提：外来账本自己观察了 tool/call');
    const consumption = foreign.consume({ sessionId, turn: 1, step: 1, callId: 'c-' + tag });
    assert.equal(isOriginLedgerConsumption(consumption), true,
      '前提：外来账本确实签发了一个**品牌** consumption（所以拒绝不可能靠「形状不像」）');
    return consumption;
  };

  // (a) 不同 sessionId 的账本：借用一个自报的 session 把它带进来。
  const foreignOther = foreignFor('s-foreign', 'a');
  const viaOtherSession = await w.host.dispatch('comment', COMMENT_INPUT, {
    sessionId: SESSION, callId: 'c-a', binding: foreignOther,
  });
  assert.deepEqual(viaOtherSession, { ok: false, error: 'origin-unverified' },
    '★★★ 别的 session 签发的 consumption 必须被拒（session 与 context 不符）');
  // 换成它自己的 sessionId 也不行：宿主没有这个 session 的账本，而授权器绝不发账本。
  const viaForeignSession = await w.host.dispatch('comment', COMMENT_INPUT, {
    sessionId: 's-foreign', callId: 'c-a', binding: foreignOther,
  });
  assert.deepEqual(viaForeignSession, { ok: false, error: 'origin-unverified' },
    '★★★ 宿主没持有的 session 一律拒绝（authorizeSource 不是恒 true，也不会顺手铸账本）');
  assert.deepEqual(w.host.status().ledgers.sessions, [SESSION],
    '★★ 外来 session 没有换来一个新账本');

  // (b) 同 sessionId、但账本对象不同：形状完全一致，仍然必须拒（ownsConsumption 的品牌归属）。
  const foreignSame = foreignFor(SESSION, 'b');
  const viaSameSession = await w.host.dispatch('comment', COMMENT_INPUT, {
    sessionId: SESSION, callId: 'c-b', binding: foreignSame,
  });
  assert.deepEqual(viaSameSession, { ok: false, error: 'origin-unverified' },
    '★★★ 同 session 的**另一个**账本对象签发的 consumption 必须被拒：'
    + '这条断了意味着授权只看字段、不看账本身份');

  assert.equal(w.bridgeSideAsks.length, 0, '★★ 三种外来来源连审批都不该问');
  assert.equal(w.sent.length, 0, '★★★ send 0 次');
  assert.equal(w.calls.length, 0);
  assert.equal(w.broker.listPending().length, 0, '★★ 没有票据');
  assert.deepEqual(w.rows(), [], '★★ 没有审批行');
  assert.deepEqual(w.claimedKeys(), [], '★★ 没有 B2 占用');

  // 控制组：宿主自己账本签发的同形状 consumption（走 binding 分支）必须放行。
  const selfConsumption = (() => {
    owned.registerBridgeRequest({ requestId: REQUEST, origin: 'qq-inbound' });
    assert.equal(owned.observeStep({
      sessionId: SESSION, turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: REQUEST } }],
    }), true);
    assert.equal(owned.observeToolCall({
      sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c-self' } },
    }), true);
    return owned.consume({ sessionId: SESSION, turn: 1, step: 1, callId: 'c-self' });
  })();
  assert.equal(isOriginLedgerConsumption(selfConsumption), true, '前提：宿主账本签发了品牌 consumption');
  const pending = w.host.dispatch('comment', COMMENT_INPUT, {
    sessionId: SESSION, callId: 'c-self', binding: selfConsumption,
  });
  const [ticket] = await w.waitForTickets(1);
  assert.equal(w.decide(ticket, true), true);
  const ok = await pending;
  assert.equal(ok.ok, true, '★★ 控制组：宿主自己账本的 consumption 必须放行：' + JSON.stringify(ok));
  assert.equal(w.sent.length, 1);
  w.host.teardown();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// D13. 默认关闭：不传 writeWiring
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('I3-D13 不传 writeWiring ⇒ comment/reply/like 是 write-not-wired、publish 是 origin-unverified，send 0 次', async (t) => {
  // mode 显式给 'enabled'：这样「写不出去」只可能来自缺少 writeWiring，而不是模式默认关闭。
  const w = await world(t, { withWiring: false, mode: 'enabled' });
  assert.deepEqual(w.host.status().writeWiring, { supplied: false, status: 'not-supplied', actions: [] },
    '★★ status 必须如实报告「没有装配写」');

  const cases = [
    ['comment', COMMENT_INPUT, 'c-off-comment', 'write-not-wired'],
    ['reply', REPLY_INPUT, 'c-off-reply', 'write-not-wired'],
    ['like', LIKE_INPUT, 'c-off-like', 'write-not-wired'],
    // publish 没有单一 target_uin，早于写分支就死在绑定铸不出来 —— 老拒绝原因必须原样保留。
    ['publish', PUBLISH_INPUT, 'c-off-publish', 'origin-unverified'],
  ];
  for (const [action, input, callId, expected] of cases) {
    const result = await w.host.dispatch(action, input, w.position(callId));
    assert.deepEqual(result, { ok: false, error: expected },
      '★★★ 没有显式 writeWiring 时 ' + action + ' 必须被拒为 ' + expected + '（实际 ' + JSON.stringify(result) + '）');
  }
  assert.equal(w.sent.length, 0, '★★★ 默认关闭：send 0 次');
  assert.equal(w.calls.length, 0, '★★ 读传输 0 次');
  assert.equal(w.bridgeSideAsks.length, 0, '★★ 写都没接线，更不该去问审批');
  assert.deepEqual(w.rows(), [], '★★ 没有审批行');
  assert.deepEqual(w.claimedKeys(), [], '★★ 没有 B2 占用');
  assert.equal(w.store.read().ledger.used.comment, 0, '★★ 没有配额消耗');
  w.host.teardown();
});
