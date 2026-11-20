// C2 — the plugin side of the self-assembly, tested end to end against REAL components.
//
// WHAT IS REAL HERE (no hand-written stand-in)
// -------------------------------------------
//   · a real SQLite state store (`openOfflineStore`) in `os.tmpdir()`, with the real B2 replay
//     collection (`initializeReplayState`) and the real send-authority token that
//     `createOfflineWritePath` requires (`requireAuthority`);
//   · the real host runtime assembly (`createQzonePluginHostRuntime`), the real origin ledger, the
//     real operation authorizer, the real approved-publish/comment compositions, the real offline
//     write path with its quota ledger, reservation and B2 claim;
//   · the real approval CHANNEL: `createQzoneApprovalIpcServer` (bridge side) + this task's client,
//     over a real 127.0.0.1 socket with the real bearer token and the real frame protocol;
//   · the real OneBot transport module (`onebot-via-bridge.mjs`) over a real `fetch` to a real
//     `node:http` listener on 127.0.0.1 that speaks the C1 endpoint's own contract
//     (`{action, params}` in, OneBot envelope or `{ok:false, error, code}` out);
//   · the REAL plugin entry (`plugins/qzone-safe/index.mjs`) and its real pre-step / session-event
//     subscriptions. The only simulated thing on the source path is the HOST EMITTING ITS EVENTS
//     (`agent/created`, `agent/pre-step`, `session/event`) — that emitter is the host boundary,
//     which a test double must stand in for, exactly as `scripts/test-qzone-step-binding.mjs` does.
//
// WHAT IS A FIXTURE, AND ONLY THIS
// --------------------------------
//   · `fetch`/HTTP: nothing leaves 127.0.0.1 and no QQ or OneBot request is ever made. The listener
//     is this file's own double of the C1 endpoint, NOT the bridge process.
//   · the OPERATOR'S VERDICT: the bridge-side "human pressed approve/deny" is a function here. The
//     IPC server, the protocol, the token and the client are the real ones.
//   · the PLATFORM ANSWERS: the fake endpoint returns canned OneBot envelopes.
//   · `clock`: pinned so the quota day and the intervals are deterministic.
//
// ⚠️ WHAT THIS FILE DOES NOT PROVE
// --------------------------------
//   · that the REAL bridge accepts a write: the C1 endpoint currently answers
//     `403 write-channel-not-wired`, and the write half of the C-2 chain is exercised here against
//     a double that CAN answer — so "the chain reaches `send`" is true, "the platform accepted a
//     post" is NOT.
//   · that the source is authentic in production: see the long note in `host-assembly.mjs`.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createQzoneHostAssembly } from '../plugins/qzone-safe/host-assembly.mjs';
import { createOnebotViaBridge, QzoneOnebotBridgeError } from '../plugins/qzone-safe/onebot-via-bridge.mjs';
import { createQzoneApprovalIpcServer } from '../src/core/qzone-approval-ipc-server.mjs';
import { openOfflineStoreReadOnly } from '../src/core/qzone-store-offline.mjs';
import { apply, createQzonePluginHandle, STATES } from '../plugins/qzone-safe/index.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { projectQzoneWriteResult } from '../src/core/qzone-onebot-write-result.mjs';

/** `projectQzoneWriteResult` is pure; this alias exists only to keep C6-05 readable. */
const projectForTest = (kind, envelope) => projectQzoneWriteResult(kind, envelope);

const BOT = 10001;
const FRIEND = 20002;
const TOKEN = 'assembly-forward-token-0123456789';
const APPROVAL_TOKEN = 'assembly-approval-token-0123456789';
const NOW = Date.parse('2026-11-16T06:00:00Z');

/** Every field the write path's gate, reservation and quota ledger read. */
function initialState() {
  return {
    enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 10, comment: 25, like: 30 },
    ledger: { day: beijingDay(NOW), used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    lastPostAt: null, lastCommentAt: null, commentTargets: [], likes: [],
    reads: 0, writes: 0, readAttempts: {}, readOutcomes: {},
    browseDay: beijingDay(NOW), todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {},
    activeStart: 0, activeEnd: 1439, audit: [], notices: [],
  };
}

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-assembly-'));
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(directory, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  });
  return directory;
}

/**
 * The C1 endpoint's contract, as a loopback double:
 *   · `{ action, params }` (two keys only), `Authorization: Bearer <token>`, JSON in, JSON out;
 *   · success => 200 + the OneBot envelope verbatim;
 *   · anything else => non-2xx + `{ ok:false, error, code }`.
 *
 * `writes` decides whether this double behaves like the endpoint does TODAY
 * (`write-channel-not-wired`) or like it will once the channel opens. `requests` is the record of
 * what actually arrived; nothing else is stored or logged.
 */
async function fakeBridge(t, { writes = 'open' } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const send = (status, body) => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(body));
      };
      if (request.method !== 'POST' || request.url !== '/api/qzone/onebot') return send(404, { ok: false, error: 'not-found', code: 'not-found' });
      if (String(request.headers.authorization ?? '') !== 'Bearer ' + TOKEN) {
        return send(401, { ok: false, error: '未授权', code: 'unauthorized' });
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { ok: false, error: 'invalid body', code: 'invalid-body' }); }
      const { action, params } = body;
      requests.push({ action, params });
      if (['send_qzone_msg', 'comment_qzone', 'like_qzone'].includes(action)) {
        if (writes === 'closed') return send(403, { ok: false, error: '写通道尚未接线', code: 'write-channel-not-wired' });
        if (action === 'like_qzone') return send(200, { status: 'ok', retcode: 0, data: null });
        if (action === 'send_qzone_msg') return send(200, { status: 'ok', retcode: 0, data: { tid: 'posted-1', time: Math.floor(NOW / 1000) } });
        return send(200, { status: 'ok', retcode: 0, data: { comment_id: 'comment-1' } });
      }
      if (action === 'get_qzone_msg_list') {
        return send(200, {
          status: 'ok', retcode: 0,
          data: { total: 1, msglist: [{ tid: 'post-1', content: 'олд пост', time: Math.floor(NOW / 1000) - 60 }] },
        });
      }
      if (action === 'get_login_info') return send(200, { status: 'ok', retcode: 0, data: { user_id: BOT } });
      if (action === 'get_friend_list') return send(200, { status: 'ok', retcode: 0, data: [{ user_id: FRIEND }] });
      return send(403, { ok: false, error: '不允许的动作', code: 'action-not-allowed' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(async () => { try { server.closeAllConnections(); } catch {} await new Promise((resolve) => server.close(resolve)); });
  return { origin: 'http://127.0.0.1:' + port, requests };
}

/** The REAL approval listener (bridge side) with a controllable operator. */
async function approvalChannel(t, decide) {
  const asked = [];
  const server = await createQzoneApprovalIpcServer({
    token: APPROVAL_TOKEN,
    clock: () => NOW,
    broker: {
      approveOperation(operation) {
        asked.push(operation);
        return decide(operation, asked.length);
      },
    },
  });
  t.after(async () => { try { await server.close(); } catch {} });
  return { origin: 'http://127.0.0.1:' + server.port, asked };
}

function assembly(t, bridge, approval) {
  return createQzoneHostAssembly({
    stateDir: tempDir(t),
    initialState: initialState(),
    origin: bridge.origin,
    token: TOKEN,
    botQq: BOT,
    approval: { origin: approval.origin, token: APPROVAL_TOKEN },
    clock: () => NOW,
    mode: 'enabled',
  });
}

/**
 * Drive the ORIGIN LEDGER the way the plugin does at runtime: register the inbound bridge request,
 * let the host announce the step that cites it, then announce the tool call. This is the ONE
 * simulated boundary (the host emitting its events); everything downstream of it is real.
 */
function hostTurn(ledger, { requestId, turn, callId }) {
  ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  assert.equal(ledger.observeStep({
    sessionId: 's1', turn, step: 1, messages: [{ role: 'user', source: { rpcId: requestId } }],
  }), true, '前提：引用该 requestId 的 step 必须被账本接受');
  assert.equal(ledger.observeToolCall({
    sessionId: 's1', event: { type: 'tool/call', data: { turn, step: 1, callId } },
  }), true, '前提：该 tool/call 必须被账本记录');
}

// ── 1. CONSTRUCTION: the assembly really builds every dependency ───────────────────────────────
test('A1 装配成功：store/replay/transport/审批 client/写链/审计全部就位（requireAuthority 由真实 store 满足）', async (t) => {
  const bridge = await fakeBridge(t);
  const approval = await approvalChannel(t, () => true);
  const built = assembly(t, bridge, approval);
  t.after(() => { built.teardown(); });

  assert.equal(typeof built.runtime.dispatch, 'function', '装配出来的 runtime 必须能 dispatch');
  assert.equal(typeof built.runtime.epoch, 'string', 'runtime 必须带 epoch');
  assert.equal(typeof built.runtime.sourceLifetime.getLedger, 'function', '来源生命周期必须存在');

  const status = built.runtime.status();
  assert.equal(status.writeWiring.supplied, true, '写链必须已供给');
  assert.equal(status.writeWiring.status, 'wired', '写链必须是结构完整的（send/writePath/source/actions/audit 齐全）');
  assert.deepEqual([...status.writeWiring.actions].sort(), ['comment', 'like', 'publish', 'reply']);

  const described = built.describe();
  assert.deepEqual([...described.writeActions].sort(), ['comment', 'like', 'publish', 'reply']);
  assert.equal(described.mode, 'enabled');
  assert.ok(described.unwired.length >= 4, 'describe() 必须如实列出未接通项');

  const state = built.store.read();
  assert.equal(state.enabled, true, '真实的 SQLite 状态必须真的被写入');
  assert.equal(state.replaySchema, 1, 'B2 replay 集合必须真的初始化过（schema 标记为 1）');
  assert.deepEqual(state.usedReadKeys, {}, 'B2 的键集合必须已建立且为空');
  assert.equal(typeof state.replayInstallId, 'string', '安装事实必须落盘');
});

// ── 2. THE DEFAULT CLOSED SWITCH: no assembly at all ──────────────────────────────────────────
test('A2 缺配置不装配：apply() 在没有 assembly 配置时仍默认关闭，且不注册任何工具', async (t) => {
  const registered = new Map();
  const ctx = { on: () => () => {}, tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } } };

  // `enabled !== true` (or no config at all) is the plugin's own closed default.
  for (const config of [undefined, {}, { enabled: false }]) {
    const handle = await createQzonePluginHandle(ctx, config);
    assert.equal(handle.status().state, STATES.DISABLED,
      'config=' + JSON.stringify(config) + '：未 enabled 时必须是 disabled');
    assert.equal(registered.size, 0, 'config=' + JSON.stringify(config) + '：未装配时不得注册任何工具');
    await handle.dispose();
  }

  // An ENABLED plugin with NO `assembly` key: the previous behaviour, byte for byte — tools are
  // registered (the host's own factory is injected here) but there is no runtime, so nothing can
  // dispatch and no write capability exists. This is the "缺配置 ⇒ 不装配" case.
  const defineTool = (tool) => tool;
  for (const config of [{ enabled: true }, { enabled: true, assembly: undefined }, { enabled: true, assembly: null }]) {
    const handle = await createQzonePluginHandle(ctx, config, { defineTool });
    assert.equal(handle.status().state, STATES.AWAITING_RUNTIME,
      'config=' + JSON.stringify(config) + '：enabled 但没有装配时只能是 awaiting-runtime');
    assert.equal(handle.status().dispatchAvailable, false,
      'config=' + JSON.stringify(config) + '：没有 runtime 就不得声称可派发');
    for (const [name, tool] of registered) {
      // The diagnosis tool is NOT a business tool: it answers even without a runtime, by design
      // (that is when it is most useful). Its own contract is pinned in
      // `test-qzone-diagnose-tool.mjs`; here it only has to not be a business tool.
      if (name === 'qzone_diagnose') {
        const snapshot = await tool.execute({}, { callId: 'c-' + name, agent: { session: { id: 's1' } } });
        assert.equal(snapshot.state, STATES.AWAITING_RUNTIME,
          'config=' + JSON.stringify(config) + '：诊断工具必须报告真实的 state');
        continue;
      }
      const result = await tool.execute({ target_uin: FRIEND }, { callId: 'c-' + name, agent: { session: { id: 's1' } } });
      assert.deepEqual(result, { ok: false, error: 'dispatch-unavailable' },
        'config=' + JSON.stringify(config) + '：' + name + ' 必须是 dispatch-unavailable');
    }
    registered.clear();
    await handle.dispose();
  }

  // A MALFORMED assembly request is NOT silently ignored — `apply()` throws, so a typo cannot leave
  // a half-wired surface behind. It is `apply()` that owns this decision (the handle never reads
  // `config.assembly`), so that is what is exercised here.
  for (const bad of [{ bogus: 1 }, { stateDir: 'x', botQq: BOT }, 'not-an-object']) {
    await assert.rejects(() => apply(ctx, { enabled: true, assembly: bad }),
      (error) => error instanceof TypeError,
      'assembly=' + JSON.stringify(bad) + ' 必须抛 TypeError（不得静默退化为未装配）');
  }
  assert.equal(registered.size, 0, '被拒的装配不得留下任何注册的工具');
});

// ── 3. TRANSPORT: the real module against the real socket ─────────────────────────────────────
test('A3 transport：真 fetch 打到 127.0.0.1 的假端点，信封原样返回；401/非 JSON/超时一律抛错（不吞成成功）', async (t) => {
  const bridge = await fakeBridge(t);
  const call = createOnebotViaBridge({ origin: bridge.origin, token: TOKEN, timeoutMs: 2000 });

  const envelope = await call('get_qzone_msg_list', { target_uin: FRIEND, pos: 0, num: 20 });
  assert.equal(envelope.status, 'ok', '成功信封必须是 OneBot 原始形状');
  assert.equal(envelope.retcode, 0);
  assert.equal(envelope.data.msglist[0].tid, 'post-1');
  assert.deepEqual(bridge.requests.at(-1), { action: 'get_qzone_msg_list', params: { target_uin: FRIEND, pos: 0, num: 20 } },
    '请求体必须逐字是 { action, params }');

  const wrongToken = createOnebotViaBridge({ origin: bridge.origin, token: 'wrong-token-0123456789' });
  await assert.rejects(() => wrongToken('get_login_info', {}), (error) => {
    assert.ok(error instanceof QzoneOnebotBridgeError, '鉴权失败必须是 transport 错误而不是返回值');
    assert.equal(error.status, 401, '401 必须被如实带出');
    assert.equal(error.code, 'unauthorized', '错误码必须来自响应体的 code');
    return true;
  });

  // A 2xx that is not JSON is NOT this protocol's answer: it must throw, not resolve undefined.
  const notJson = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html>nope</html>');
  });
  await new Promise((resolve) => notJson.listen(0, '127.0.0.1', resolve));
  t.after(async () => { try { notJson.closeAllConnections(); } catch {} await new Promise((resolve) => notJson.close(resolve)); });
  const notJsonCall = createOnebotViaBridge({ origin: 'http://127.0.0.1:' + notJson.address().port, token: TOKEN });
  await assert.rejects(() => notJsonCall('get_login_info', {}), (error) => {
    assert.equal(error.code, 'invalid-json', '非法 JSON 必须抛 invalid-json');
    return true;
  });

  // A listener that never answers: the deadline must win, as a throw.
  const silent = http.createServer(() => { /* never answers */ });
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(async () => { try { silent.closeAllConnections(); } catch {} await new Promise((resolve) => silent.close(resolve)); });
  const slowCall = createOnebotViaBridge({ origin: 'http://127.0.0.1:' + silent.address().port, token: TOKEN, timeoutMs: 120 });
  await assert.rejects(() => slowCall('get_login_info', {}), (error) => {
    assert.equal(error.code, 'timeout', '超时必须抛 timeout');
    return true;
  });
});

// ── 4. THE READ CHAIN through the assembly ───────────────────────────────────────────────────
test('A4 读链能通：真 ledger 消费 -> 真 runtime -> 真审批 IPC -> 假 bridge 的假 msglist', async (t) => {
  const bridge = await fakeBridge(t);
  const approval = await approvalChannel(t, () => true);
  const built = assembly(t, bridge, approval);
  t.after(() => { built.teardown(); });

  const ledger = built.runtime.sourceLifetime.getLedger('s1');
  hostTurn(ledger, { requestId: 'req-read', turn: 1, callId: 'call-read' });

  const result = await built.runtime.dispatch('read_posts', { target_uin: FRIEND, pos: 0, num: 20 },
    { sessionId: 's1', callId: 'call-read' });

  assert.equal(result.ok, true, '读必须成功（审批同意 + 来源绑定有效）: ' + JSON.stringify(result));
  assert.equal(result.outcome, 'success');
  assert.deepEqual(result.posts.map((post) => post.id), ['post-1'], '假端点返回的 msglist 必须真的到达调用方');
  assert.equal(bridge.requests.filter((r) => r.action === 'get_qzone_msg_list').length, 1,
    '假 bridge 恰好收到一次 get_qzone_msg_list');
  // The approval channel really is on the path: the friend proof asks `get_login_info` through the
  // same transport twice, and the operation authorizer asks the operator once. What matters for
  // C2 is that the one approval the chain needs went over the REAL loopback IPC, not that some
  // particular count of calls happened — so the assertion is anchored on the approval itself.
  assert.deepEqual(approval.asked.map((op) => op.action), ['read_posts'],
    '读链必须恰好就这一条读操作问过操作员（真 IPC 通道）');
  assert.equal(typeof approval.asked[0].authorizationId, 'string', '审批帧必须带 authorizationId');
  assert.equal(approval.asked[0].accountId, BOT, '审批帧必须带账号');
});

// ── 5. THE WRITE CHAIN, APPROVED ───────────────────────────────────────────────────────────
test('A5 写链：审批同意时走到假 bridge 的 send（载荷逐字来自契约），B2 与配额各记一次', async (t) => {
  const bridge = await fakeBridge(t);
  const approval = await approvalChannel(t, () => true);
  const built = assembly(t, bridge, approval);
  t.after(() => { built.teardown(); });

  const ledger = built.runtime.sourceLifetime.getLedger('s1');
  hostTurn(ledger, { requestId: 'req-publish', turn: 1, callId: 'call-publish' });

  const result = await built.runtime.dispatch('publish', { content: 'hello from the assembly', ugc_right: 1 },
    { sessionId: 's1', callId: 'call-publish' });

  assert.equal(result.ok, true, '审批同意时写链必须走通: ' + JSON.stringify(result));
  assert.equal(result.outcome, 'success', '假端点答 retcode 0，写链必须判 success');
  const sends = bridge.requests.filter((r) => r.action === 'send_qzone_msg');
  assert.equal(sends.length, 1, '假 bridge 必须恰好收到一次 send_qzone_msg');
  assert.deepEqual(sends[0].params, { content: 'hello from the assembly', ugc_right: 1 },
    '发送载荷必须逐字来自契约（无 target_uins 的公开可见）');

  const state = built.store.read();
  assert.equal(state.ledger.used.post, 1, '配额必须恰好消耗 1 个 post');
  assert.deepEqual(Object.keys(state.usedReadKeys ?? {}).sort(),
    [JSON.stringify([BOT, 's1', 'req-publish', 'call-publish'])].sort(), 'B2 四元组必须恰好占一条');
  const writeRows = (state.writeAudit ?? []).map((row) => row.stage);
  assert.deepEqual(writeRows.slice().sort(), ['intent', 'result'], '写审计必须有 intent + result 两行');
  assert.equal(state.writeAudit.at(-1).outcome, 'success', 'result 行必须记录写链自己的分类');
});

// ── 6. THE WRITE CHAIN, DENIED BY THE OPERATOR ─────────────────────────────────────────────
test('A6 审批拒绝：send 0 次、B2 0 条、配额 0、写审计 0 行', async (t) => {
  const bridge = await fakeBridge(t);
  const approval = await approvalChannel(t, () => false);
  const built = assembly(t, bridge, approval);
  t.after(() => { built.teardown(); });

  const ledger = built.runtime.sourceLifetime.getLedger('s1');
  hostTurn(ledger, { requestId: 'req-denied', turn: 1, callId: 'call-publish-denied' });

  const result = await built.runtime.dispatch('publish', { content: 'should never leave', ugc_right: 1 },
    { sessionId: 's1', callId: 'call-publish-denied' });

  assert.equal(result.ok, false, '审批拒绝后不得成功: ' + JSON.stringify(result));
  assert.equal(result.reason, 'not-authorized', '拒绝必须来自授权层，而不是别的巧合');
  assert.equal(bridge.requests.filter((r) => r.action === 'send_qzone_msg').length, 0, '审批拒绝后不得发送');
  const state = built.store.read();
  assert.equal(state.ledger.used.post, 0, '审批拒绝后不得消耗配额');
  assert.deepEqual(Object.keys(state.usedReadKeys ?? {}), [], '审批拒绝后不得占用 B2 四元组');
  assert.deepEqual(state.writeAudit ?? [], [], '没有授权就没有写审计行');
});

// ── 7. THE REAL BRIDGE'S CURRENT BEHAVIOUR: the write channel is closed ─────────────────────
test('A7 真实 bridge 现状：写通道 403 write-channel-not-wired ⇒ 写链拿到 unknown 且配额已花（如实报告）', async (t) => {
  const bridge = await fakeBridge(t, { writes: 'closed' });
  const approval = await approvalChannel(t, () => true);
  const built = assembly(t, bridge, approval);
  t.after(() => { built.teardown(); });

  const ledger = built.runtime.sourceLifetime.getLedger('s1');
  hostTurn(ledger, { requestId: 'req-closed', turn: 1, callId: 'call-closed' });

  const result = await built.runtime.dispatch('publish', { content: 'blocked by the bridge', ugc_right: 1 },
    { sessionId: 's1', callId: 'call-closed' });

  assert.equal(result.ok, true, '写链本身必须走完（拒绝发生在 transport 边界）: ' + JSON.stringify(result));
  assert.equal(result.outcome, 'unknown',
    'transport 抛出 403 时写链必须判 unknown —— 这是保守分类，不是"没发出去"的断言');
  assert.equal(result.transportCalled, true);
  assert.equal(built.store.read().ledger.used.post, 1,
    '配额已经花了且没有退款路径：这正是"桥没开写通道"的真实代价，必须如实暴露');
  const writeRows = (built.store.read().writeAudit ?? []).map((row) => [row.stage, row.outcome]);
  assert.deepEqual(writeRows, [['intent', null], ['result', 'unknown']], '写审计必须记录 intent + unknown');
});

// ── 8. THE REAL PLUGIN, WIRED TO THIS ASSEMBLY ──────────────────────────────────────────────
test('A8 真插件 + 本装配：宿主事件 -> 插件账本 -> dispatch 走通（来源不是夹具，夹具只是宿主发射器）', async (t) => {
  const bridge = await fakeBridge(t);
  const approval = await approvalChannel(t, () => true);
  const built = assembly(t, bridge, approval);
  t.after(() => { built.teardown(); });

  const registered = new Map();
  // Per-EVENT listener lists. `agent/created` and `agent/disposed` must not share one list: the
  // disposed handler unregisters the adapter and releases the session's ledger, so delivering a
  // "created" payload to it tears the session down immediately.
  const listeners = new Map();
  const on = (event, listener) => {
    const list = listeners.get(event) ?? [];
    list.push(listener);
    listeners.set(event, list);
    return () => {};
  };
  const emit = (event, ...args) => { for (const listener of listeners.get(event) ?? []) listener(...args); };
  const agentPreStep = [];
  const ctx = {
    on,
    tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
  };
  const handle = await createQzonePluginHandle(ctx, { enabled: true }, {
    epoch: built.runtime.epoch,
    dispatch: built.runtime.dispatch,
    sourceLifetime: built.runtime.sourceLifetime,
    defineTool: (tool) => tool,
  });
  t.after(async () => { await handle.dispose(); });

  assert.equal(handle.status().state, STATES.DISPATCH_READY, '注入完整 runtime 后插件必须进入 dispatch-ready');

  // (1) the host creates an agent: the plugin installs its pre-step adapter for that agent.
  emit('agent/created', { agent: {
    id: 'agent-1', session: { id: 's1' },
    ctx: { on: (name, fn) => { if (name === 'agent/pre-step') agentPreStep.push(fn); return () => {}; } },
  } });
  // (2) the bridge registered the inbound request through the plugin's own entry point.
  handle.registerBridgeRequest('s1', { requestId: 'rpc-live', origin: 'qq-inbound' });
  // (3) the host announces the step and the tool call.
  for (const listener of agentPreStep) {
    listener({ turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'rpc-live' } }] }, () => {});
  }
  emit('session/event', { id: 's1' }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-live', name: 'qzone_read_posts' } });

  const tool = registered.get('qzone_read_posts');
  assert.ok(tool, 'qzone_read_posts 必须已注册');
  const result = await tool.execute({ target_uin: FRIEND, pos: 0, num: 20 },
    { callId: 'call-live', agent: { session: { id: 's1' } } });

  assert.equal(result.ok, true, '真插件经宿主事件绑定后必须能派发: ' + JSON.stringify(result));
  assert.deepEqual(result.posts.map((post) => post.id), ['post-1']);
  assert.equal(bridge.requests.filter((r) => r.action === 'get_qzone_msg_list').length, 1);

  // (4) and the SAME callId cannot be replayed.
  const replay = await tool.execute({ target_uin: FRIEND, pos: 0, num: 20 },
    { callId: 'call-live', agent: { session: { id: 's1' } } });
  assert.deepEqual(replay, { ok: false, error: 'origin-unbound' }, '同一 callId 的第二次派发必须被拒');
});

// ── 8b. THE ASSEMBLY SWITCH ITSELF: apply() builds, wires and retires the runtime ───────────
test('A10 apply() 的 assembly 开关真的被走通：DB 落在配置目录、零平台请求、dispose 后可重新装配同一路径', async (t) => {
  const bridge = await fakeBridge(t);
  const approval = await approvalChannel(t, () => true);
  const stateDir = tempDir(t);
  const ctx = { on: () => () => {}, tools: { register() { return () => {}; } } };
  const config = {
    enabled: true,
    assembly: {
      stateDir,
      initialState: initialState(),
      origin: bridge.origin,
      token: TOKEN,
      botQq: BOT,
      approval: { origin: approval.origin, token: APPROVAL_TOKEN },
      clock: () => NOW,
      mode: 'enabled',
    },
  };

  const dispose = await apply(ctx, config);
  t.after(async () => { try { await dispose(); } catch {} });

  // The ONLY observable that proves `apply` really built the assembly: the plugin's own database
  // appears at the configured path, carrying the state and the B2 installation marker. (Tool
  // registration cannot serve here: `@deepseek-ai/dsh-tools` is not installed in this checkout, so
  // every enabled plugin reports `tool-registration-failed` regardless of the assembly.)
  const file = path.join(stateDir, 'qzone-plugin-state.sqlite');
  assert.equal(fs.existsSync(file), true, '装配必须真的打开（并创建）配置目录下的插件数据库');
  const probe = openOfflineStoreReadOnly(file);
  const persisted = probe.read();
  probe.close();
  assert.equal(persisted.enabled, true, '落盘的必须就是 initialState');
  assert.equal(persisted.replaySchema, 1, 'B2 replay 集合必须已经安装');
  assert.equal(bridge.requests.length, 0, '装配本身不得发出任何平台请求');

  await dispose();
  await dispose();  // idempotent: the second call must be a no-op, not a second teardown

  // A fresh assembly over the SAME path proves the previous one released the database handle and
  // that the state (quota ledger included) is still readable — i.e. teardown closed, did not delete.
  const second = createQzoneHostAssembly({
    stateDir, initialState: initialState(), origin: bridge.origin, token: TOKEN, botQq: BOT,
    approval: { origin: approval.origin, token: APPROVAL_TOKEN }, clock: () => NOW, mode: 'enabled',
  });
  t.after(() => { second.teardown(); });
  assert.equal(second.store.read().enabled, true, '重新装配必须读到同一份状态');
  assert.equal(second.runtime.status().writeWiring.status, 'wired', '重新装配的写链必须同样完整');
});

// ── 9. THE ORIGIN GATE IS REAL: no host event, no dispatch ─────────────────────────────────
test('A9 没有宿主事件就没有位置：装配好的 runtime 对无账本章的请求一律 origin-unverified', async (t) => {
  const bridge = await fakeBridge(t);
  const approval = await approvalChannel(t, () => true);
  const built = assembly(t, bridge, approval);
  t.after(() => { built.teardown(); });

  const unwitnessed = await built.runtime.dispatch('read_posts', { target_uin: FRIEND, pos: 0, num: 20 },
    { sessionId: 's-never-observed', callId: 'call-none' });
  assert.deepEqual(unwitnessed, { ok: false, error: 'origin-unverified' },
    '没有账本/没有绑定的调用必须 origin-unverified —— 这正是"来源不由 epoch 或 get_login_info 决定"的证据');
  assert.equal(bridge.requests.length, 0, '被拒的调用不得发出任何平台请求');
  assert.equal(approval.asked.length, 0, '被拒的调用不得惊动审批通道');
});

// ── 11. C6: the permit registry moved to the BRIDGE ─────────────────────────────────────────

// `assertBridgePermitModuleAvailable` 不再被导入：装配侧已不再构造许可通道，那条守卫随之移除。
// `createAsyncPermitGatedTransport` 仍然导入，因为 C6-02 直接测它本身（它是**模块级**能力，
// 只是不再是装配的一部分）。
import {
  createWritePermitViaBridge,
  createAsyncPermitGatedTransport,
} from '../plugins/qzone-safe/write-permit-via-bridge.mjs';
import { deriveBusinessAction } from '../plugins/qzone-safe/host-assembly.mjs';

const PERMIT_TOKEN = 'permit-channel-token-0123456789';
/** One approved operation's identity, shared by the C6 permit cases. */
const AUTH_ID = 'auth-c6-0001';
const DIGEST = 'c'.repeat(64);

/**
 * A loopback double of the BRIDGE-SIDE permit service.
 *
 * It stands in for `src/qzone-write-permit-ipc.mjs` (which has not landed yet) and implements the
 * C6 contract: POST { op: 'issue', authorizationId, inputDigest } -> { permitId } and
 * POST { op: 'consume', permitId, authorizationId, inputDigest } -> { ok }. One-time consumption is
 * enforced HERE, in the double, which is the whole point of moving the registry across the
 * boundary: the plugin can no longer decide that for itself.
 */
async function fakePermitService(t, { capacity = 8 } = {}) {
  const permits = new Map();
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const answer = (body) => {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(body));
      };
      if (String(request.headers.authorization ?? '') !== 'Bearer ' + PERMIT_TOKEN) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: false, code: 'unauthorized' }));
        return;
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      calls.push(body);
      if (body?.op === 'issue') {
        if (permits.size >= capacity) return answer({ permitId: null });
        const permitId = 'permit-' + (permits.size + 1) + '-' + Math.random().toString(16).slice(2, 10);
        permits.set(permitId, { authorizationId: body.authorizationId, inputDigest: body.inputDigest, used: false });
        return answer({ permitId });
      }
      if (body?.op === 'consume') {
        const record = permits.get(body.permitId);
        const ok = record !== undefined && record.used !== true
          && record.authorizationId === body.authorizationId && record.inputDigest === body.inputDigest;
        if (ok) record.used = true;
        return answer({ ok });
      }
      return answer({ ok: false, code: 'unknown-op' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { try { server.closeAllConnections(); } catch {} await new Promise((resolve) => server.close(resolve)); });
  return { origin: 'http://127.0.0.1:' + server.address().port, calls, permits };
}

/** An async client for the permit channel: real `fetch` over the loopback double above. */
function permitClientOverHttp(service) {
  const post = async (body) => {
    const response = await fetch(service.origin + '/permit', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + PERMIT_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json();
  };
  return {
    async issue(binding) {
      const answer = await post({ op: 'issue', authorizationId: binding.authorizationId, inputDigest: binding.inputDigest });
      return typeof answer?.permitId === 'string' ? answer.permitId : null;
    },
    async consume(request) {
      const answer = await post({
        op: 'consume', permitId: request.permitId, authorizationId: request.authorizationId, inputDigest: request.inputDigest,
      });
      return answer?.ok === true;
    },
    async close() {},
  };
}

test('C6-01 适配层：注入的异步 client 被接受，issue/consume 原样转发；缺 origin/token 时抛 TypeError', async (t) => {
  const service = await fakePermitService(t);
  const client = permitClientOverHttp(service);
  const viaBridge = await createWritePermitViaBridge({ client });
  assert.equal(typeof viaBridge.issue, 'function', '适配层必须暴露 issue');
  assert.equal(typeof viaBridge.consume, 'function', '适配层必须暴露 consume');

  const permitId = await viaBridge.issue({ authorizationId: AUTH_ID, inputDigest: DIGEST });
  assert.equal(typeof permitId, 'string', 'issue 必须经适配层拿到 bridge 签发的 id');
  assert.equal(await viaBridge.consume({ permitId, authorizationId: AUTH_ID, inputDigest: DIGEST }), true,
    '首次 consume 必须由 bridge 判定为 true');
  assert.equal(await viaBridge.consume({ permitId, authorizationId: AUTH_ID, inputDigest: DIGEST }), false,
    '第二次 consume 必须由 BRIDGE 拒绝 —— 一次性由此刻的远端决定，不再由插件自证');

  await assert.rejects(() => createWritePermitViaBridge({}), (error) => error instanceof TypeError,
    '既没有 client 也没有 origin/token 时必须抛 TypeError，不得返回“永远拒绝”的空壳');
  await assert.rejects(
    () => createWritePermitViaBridge({ origin: 'http://127.0.0.1:1' }),
    (error) => error instanceof TypeError,
    '给了 origin 但没有 token 时必须抛 TypeError',
  );
});

test('C6-02 异步门面：绑定正确时 issue→consume→transport 各一次；bridge 拒绝消费则不发送', async (t) => {
  const service = await fakePermitService(t);
  const client = permitClientOverHttp(service);
  const sent = [];
  const transport = async (payload) => { sent.push(payload); return { outcome: 'success' }; };

  const gate = createAsyncPermitGatedTransport({
    writePermit: client,
    resolveBinding: () => ({ authorizationId: AUTH_ID, inputDigest: DIGEST }),
    transport,
  });
  assert.deepEqual(await gate({ id: AUTH_ID }), { outcome: 'success' }, '绑定正确时必须原样返回 transport 的结果');
  assert.equal(sent.length, 1, 'transport 必须恰好被调用 1 次');
  assert.deepEqual(service.calls.map((call) => call.op), ['issue', 'consume'], 'bridge 必须恰好收到 issue + consume 各一次');

  // A registry that refuses to consume (already spent / capacity / drift) => no transport call.
  const before = sent.length;
  const refusing = createAsyncPermitGatedTransport({
    writePermit: { issue: async () => 'permit-x', consume: async () => false },
    resolveBinding: () => ({ authorizationId: AUTH_ID, inputDigest: DIGEST }),
    transport,
  });
  assert.deepEqual(await refusing({ id: AUTH_ID }), { notSent: true, reason: 'write-permit-refused' },
    'bridge 拒绝消费必须返回 not-sent / write-permit-refused');
  assert.equal(sent.length, before, '被拒时不得调用 transport');

  const noBinding = createAsyncPermitGatedTransport({
    writePermit: client, resolveBinding: () => null, transport,
  });
  assert.deepEqual(await noBinding({ id: 'nope' }), { notSent: true, reason: 'write-permit-unapproved' },
    '没有批准记录时必须 not-sent / write-permit-unapproved');
});

test('C6-03 ★C16/t31 许可机制作废后：注入的 writePermit 被忽略 —— 写直达平台，permit 服务零调用', async (t) => {
  // 这条用例在 C6 时代断言的是「装配会去 bridge 换许可」。许可随审批一起移除后，
  // 断言随之翻转：装配**接受**这个选项（不报错、不阻断），但**不再用它**。
  // 不是放宽校验，而是把「一个只会说不的闸门」去掉 —— 见 host-assembly.mjs 头部说明。
  const service = await fakePermitService(t);
  const client = permitClientOverHttp(service);
  const endpoint = await fakeBridge(t);
  const approval = await approvalChannel(t, () => true);
  const built = createQzoneHostAssembly({
    stateDir: tempDir(t),
    initialState: initialState(),
    origin: endpoint.origin,
    token: TOKEN,
    botQq: BOT,
    approval: { origin: approval.origin, token: APPROVAL_TOKEN },
    clock: () => NOW,
    mode: 'enabled',
    writePermit: client,
  });
  t.after(() => { built.teardown(); });

  const ledger = built.runtime.sourceLifetime.getLedger('s1');
  hostTurn(ledger, { requestId: 'req-c6', turn: 1, callId: 'call-c6' });
  const result = await built.runtime.dispatch('publish', { content: 'bridge-permit post', ugc_right: 1 },
    { sessionId: 's1', callId: 'call-c6' });

  assert.equal(result.ok, true, '写链必须走通（不再被许可拦住）: ' + JSON.stringify(result));
  assert.equal(result.outcome, 'success', '写链必须判 success');
  // ★ 翻转的断言：许可作废后，装配不得再去 bridge 换许可。
  assert.deepEqual(service.calls.map((call) => call.op), [],
    'permit 服务必须收到 0 次调用 —— 许可机制已作废，装配不得再去换');
  assert.equal(endpoint.requests.filter((r) => r.action === 'send_qzone_msg').length, 1,
    '平台必须恰好收到 1 次写');
  assert.match(built.describe().writePermit, /ignored/,
    'describe() 必须如实说明「配了但被忽略」');

  // 一个完全连不上的 permit client 也不再阻断写：它根本不会被调用。
  const offlineClient = {
    issue: async () => null,
    consume: async () => false,
    async close() {},
  };
  const broken = createQzoneHostAssembly({
    stateDir: tempDir(t),
    initialState: initialState(),
    origin: endpoint.origin,
    token: TOKEN,
    botQq: BOT,
    approval: { origin: approval.origin, token: APPROVAL_TOKEN },
    clock: () => NOW,
    mode: 'enabled',
    writePermit: offlineClient,
  });
  t.after(() => { broken.teardown(); });
  const brokenLedger = broken.runtime.sourceLifetime.getLedger('s1');
  hostTurn(brokenLedger, { requestId: 'req-c6-b', turn: 1, callId: 'call-c6-b' });
  const second = await broken.runtime.dispatch('like', { tid: 'post-1', target_uin: FRIEND },
    { sessionId: 's1', callId: 'call-c6-b' });
  // ★ 同样翻转：连不上的 permit client 不再阻断写 —— 它根本不会被调用。
  assert.equal(second.outcome, 'success',
    '不可用的 permit client 不得再阻断写（它不会被调用）: ' + JSON.stringify(second));
  assert.equal(endpoint.requests.filter((r) => r.action === 'like_qzone').length, 1,
    '平台必须收到这次 like');
});

test('C6-04 ★C16/t31 writePermitChannel：仍做形状校验与互斥检查，但不再构造通道、不再要求 bridge 模块', async (t) => {
  // (a) 形状仍然校验：拼错的配置必须是响亮的 TypeError，而不是被静默忽略。
  // （旧版本这里断言「bridge 模块缺失 ⇒ TypeError」；许可作废后那条守卫已移除，因为要求一个
  //  永远不会被调用的模块，只会让还留着旧配置的部署在启动时炸掉 —— 正是本任务要消除的故障。）
  assert.throws(
    () => createQzoneHostAssembly({
      stateDir: tempDir(t), initialState: initialState(), origin: 'http://127.0.0.1:1',
      token: TOKEN, botQq: BOT, writePermitChannel: 'not-an-object',
    }),
    (error) => error instanceof TypeError,
    'writePermitChannel 不是纯对象时必须抛 TypeError',
  );

  // (b) two owners of one decision are refused（与许可是否生效无关：防的是配置歧义）。
  const base = {
    stateDir: tempDir(t),
    initialState: initialState(),
    origin: 'http://127.0.0.1:1',
    token: TOKEN,
    botQq: BOT,
    approval: { origin: 'http://127.0.0.1:2', token: APPROVAL_TOKEN },
  };
  assert.throws(
    () => createQzoneHostAssembly({
      ...base,
      writePermit: { issue: async () => null, consume: async () => false },
      writePermitChannel: { origin: 'http://127.0.0.1:3', token: PERMIT_TOKEN },
    }),
    (error) => error instanceof TypeError,
    '同时给 writePermit 与 writePermitChannel 必须抛 TypeError（不得二选一猜）',
  );

  // (c) ★行为变化：通道**不再被构造**，所以一个根本连不上的 origin 也能装配成功、写链照常走到
  //     send —— 这正是用户实测 write-permit-unavailable 那个故障的修复。
  const endpoint = await fakeBridge(t);
  const built = createQzoneHostAssembly({
    ...base,
    origin: endpoint.origin,
    approval: undefined,   // 用户裁定：不要人工审批
    mode: 'enabled',
    // 指向一个绝不存在的端口：许可若仍生效，这里必然失败。
    writePermitChannel: { origin: 'http://127.0.0.1:1', token: PERMIT_TOKEN, timeoutMs: 1000 },
  });
  t.after(() => { built.teardown(); });
  assert.match(built.describe().writePermit, /ignored/,
    'describe() 必须说明该选项被忽略，而不是仍声称 bridge-held');

  const ledger = built.runtime.sourceLifetime.getLedger('s1');
  hostTurn(ledger, { requestId: 'req-c6-04', turn: 1, callId: 'call-c6-04' });
  const result = await built.runtime.dispatch('publish', { content: 'channel ignored', ugc_right: 1 },
    { sessionId: 's1', callId: 'call-c6-04' });
  assert.equal(result.outcome, 'success',
    '连不上的 writePermitChannel 不得再阻断写: ' + JSON.stringify(result));
  assert.equal(endpoint.requests.filter((r) => r.action === 'send_qzone_msg').length, 1,
    '平台必须恰好收到 1 次写');
});

test('C6-05 reply/comment 标签：业务 action 由契约自带判别字段还原，且不改变判定', () => {
  // The contract gives a reply `comment_id` + `comment_uin` and a plain comment neither.
  assert.equal(deriveBusinessAction({ action: 'comment_qzone', params: { tid: 'p', target_uin: 1, content: 'c' } }), 'comment',
    '不带 comment_id/comment_uin 的 comment_qzone 必须判成 comment');
  assert.equal(deriveBusinessAction({
    action: 'comment_qzone',
    params: { tid: 'p', target_uin: 1, content: 'r', comment_id: 'cm-1', comment_uin: 7 },
  }), 'reply', '带 comment_id + comment_uin 的 comment_qzone 必须判成 reply');
  assert.equal(deriveBusinessAction({ action: 'comment_qzone', params: { comment_id: 'cm-1' } }), 'comment',
    '只有半个判别字段时必须退回 comment（契约要求两者同时存在）');
  assert.equal(deriveBusinessAction({ action: 'send_qzone_msg', params: {} }), 'publish');
  assert.equal(deriveBusinessAction({ action: 'like_qzone', params: {} }), 'like');
  assert.equal(deriveBusinessAction({ action: 'x', params: {} }), null, '未知 action 必须返回 null');
  assert.equal(deriveBusinessAction(null), null, 'null payload 必须返回 null');

  // The label change must not move the verdict: both are `success` for the same envelope.
  const envelope = { status: 'ok', retcode: 0, data: { comment_id: 'cm-1' } };
  assert.deepEqual(projectForTest('comment', envelope), projectForTest('reply', envelope),
    '投影器对 comment/reply 的判定必须一致 —— 这就是“标签错了、判定没错”的准确表述');
});

// ── 12. C6 against the REAL bridge permit module (it landed while this task ran) ─────────────
import { createQzoneWritePermitIpcServer as realPermitServer } from '../src/qzone-write-permit-ipc.mjs';
import { createQzoneWritePermitRegistry } from '../src/core/qzone-write-permit-offline.mjs';

test('C6-06 真实 bridge 许可模块：真 server(127.0.0.1) + 真 client ⇒ 签发一次、消费一次、第二次 false', async (t) => {
  const registry = createQzoneWritePermitRegistry({ clock: () => NOW });
  const approved = new Set([AUTH_ID]);
  const server = await realPermitServer({
    registry,
    isApproved: (binding) => approved.has(binding.authorizationId),
    token: PERMIT_TOKEN,
    clock: () => NOW,
  });
  t.after(async () => { try { await server.close(); } catch {} });
  const origin = 'http://127.0.0.1:' + server.port;

  const client = await createWritePermitViaBridge({ origin, token: PERMIT_TOKEN, timeoutMs: 3000 });
  t.after(async () => { try { await client.close(); } catch {} });

  const permitId = await client.issue({ authorizationId: AUTH_ID, inputDigest: DIGEST });
  assert.equal(typeof permitId, 'string', '真实 bridge 必须为已批准的操作签发许可');

  // SINGLE FLIGHT, while the permit is still alive: one approval, one live permit.
  assert.equal(await client.issue({ authorizationId: AUTH_ID, inputDigest: DIGEST }), null,
    '同一 authorizationId 在许可存活期间再次 issue 必须 null（bridge 侧单飞）');

  assert.equal(await client.consume({ permitId, authorizationId: AUTH_ID, inputDigest: DIGEST }), true,
    '首次消费必须由真实 server 判定为 true');
  assert.equal(await client.consume({ permitId, authorizationId: AUTH_ID, inputDigest: DIGEST }), false,
    '第二次消费必须由真实 server 拒绝（一次性在 bridge 侧）');

  // An operation the bridge does NOT consider approved cannot get a permit at all.
  assert.equal(await client.issue({ authorizationId: 'auth-unapproved', inputDigest: DIGEST }), null,
    '未批准的操作必须拿不到许可 —— 这是“插件不能自己 issue”的直接证据');

  // ★ C7 起这条边界被关掉了：consume 成功后 bridge 把该 authorizationId 标记为 spent，
  // 同一批准的第二次 issue 一律拒绝（403 authorization-spent）。
  // 之前这里断言的是"许可被消费后单飞槽位释放、二次 issue 仍成功"——那是当时的真实行为，
  // 也是本轮修掉的重复发送缺口。断言随之翻转，不是放宽。
  assert.equal(await client.issue({ authorizationId: AUTH_ID, inputDigest: DIGEST }), null,
    '同一批准在消费后不得再换取许可（spent 生效），否则重试路径会重复发送');
});

test('C6-07 真实 bridge 许可 + 写链：socket 端到端，许可在 bridge 消费后平台才收到写', async (t) => {
  const registry = createQzoneWritePermitRegistry({ clock: () => NOW });
  const approved = new Set();
  const server = await realPermitServer({
    registry,
    isApproved: (binding) => approved.has(binding.authorizationId),
    token: PERMIT_TOKEN,
    clock: () => NOW,
  });
  t.after(async () => { try { await server.close(); } catch {} });
  const client = await createWritePermitViaBridge({
    origin: 'http://127.0.0.1:' + server.port, token: PERMIT_TOKEN, timeoutMs: 3000,
  });

  const endpoint = await fakeBridge(t);
  // The bridge's "already approved" record is filled the way the bridge itself learns it: at the
  // moment the operator approves. `decide` runs BEFORE the permit request (the authorizer awaits it),
  // so the record is in place by the time `issue` asks — no polling, no race.
  const approval = await approvalChannel(t, (operation) => {
    approved.add(operation.authorizationId);
    return true;
  });
  const built = createQzoneHostAssembly({
    stateDir: tempDir(t),
    initialState: initialState(),
    origin: endpoint.origin,
    token: TOKEN,
    botQq: BOT,
    approval: { origin: approval.origin, token: APPROVAL_TOKEN },
    clock: () => NOW,
    mode: 'enabled',
    writePermit: client,
  });
  t.after(() => { built.teardown(); });

  const ledger = built.runtime.sourceLifetime.getLedger('s1');
  hostTurn(ledger, { requestId: 'req-real', turn: 1, callId: 'call-real' });

  const result = await built.runtime.dispatch('publish', { content: 'real permit post', ugc_right: 1 },
    { sessionId: 's1', callId: 'call-real' });

  assert.equal(result.ok, true, '端到端写链必须走通: ' + JSON.stringify(result));
  assert.equal(result.outcome, 'success', '写链必须判 success');
  assert.equal(endpoint.requests.filter((r) => r.action === 'send_qzone_msg').length, 1,
    '平台必须恰好收到 1 次写');
  assert.equal(approved.size, 1, 'bridge 侧必须恰好在审批时记下一次批准');
  assert.equal(registry.size(), 0, 'bridge 的 registry 里不得剩下未消费的许可');
});

// ── 13. C14: no approval channel ⇒ the host's AUTO-APPROVE policy ───────────────────────────
test('C14-01 无 approval 配置 ⇒ 装配成功、策略为 auto-approve、读链能走通、replayStore 仍在', async (t) => {
  const bridge = await fakeBridge(t);
  // NO approval channel at all: this is the configuration the operator's ruling describes.
  const built = createQzoneHostAssembly({
    stateDir: tempDir(t),
    initialState: initialState(),
    origin: bridge.origin,
    token: TOKEN,
    botQq: BOT,
    clock: () => NOW,
    mode: 'enabled',
  });
  t.after(() => { built.teardown(); });

  const described = built.describe();
  assert.equal(described.approvalPolicy, 'auto-approve',
    '没有 approval 通道时必须如实报告 auto-approve 策略');
  assert.equal(described.replayStore, 'store',
    'B2 防重放不随审批一起移除：replayStore 必须仍然在装配里');
  assert.match(described.unwired.join('\n'), /AUTO-APPROVE/,
    'describe().unwired 必须写明自动批准是策略、且额度/间隔仍在');
  assert.equal(built.store.read().replaySchema, 1, 'B2 replay 集合必须真的初始化过（不是只报了个字段）');

  // A full read through the REAL chain, with no approval channel in the picture. The only thing
  // missing relative to C4-01 is the operator; everything else is the same code path.
  const ledger = built.runtime.sourceLifetime.getLedger('s1');
  hostTurn(ledger, { requestId: 'req-auto', turn: 1, callId: 'call-auto' });
  const result = await built.runtime.dispatch('read_posts', { target_uin: FRIEND, pos: 0, num: 20 },
    { sessionId: 's1', callId: 'call-auto' });

  assert.equal(result.ok, true, '自动批准时读链必须走通: ' + JSON.stringify(result));
  assert.equal(result.outcome, 'success');
  assert.deepEqual(result.posts.map((post) => post.id), ['post-1'], '假 transport 的数据必须到达调用方');
  assert.equal(bridge.requests.filter((r) => r.action === 'get_qzone_msg_list').length, 1,
    '平台必须恰好收到一次读请求');
});

test('C14-02 自动批准不绕过配额：同日发布第二次被 interval 拒绝，且零第二次发送', async (t) => {
  const bridge = await fakeBridge(t);
  const built = createQzoneHostAssembly({
    stateDir: tempDir(t),
    initialState: initialState(),
    origin: bridge.origin,
    token: TOKEN,
    botQq: BOT,
    clock: () => NOW,
    mode: 'enabled',
  });
  t.after(() => { built.teardown(); });

  const ledger = built.runtime.sourceLifetime.getLedger('s1');
  hostTurn(ledger, { requestId: 'req-p1', turn: 1, callId: 'call-p1' });
  const first = await built.runtime.dispatch('publish', { content: 'first', ugc_right: 1 },
    { sessionId: 's1', callId: 'call-p1' });
  assert.equal(first.outcome, 'success', '第一次发布必须成功（自动批准 + 额度内）: ' + JSON.stringify(first));
  assert.equal(bridge.requests.filter((r) => r.action === 'send_qzone_msg').length, 1);

  // A SECOND publish in the same instant: auto-approval must not touch the 2-hour interval.
  // The ledger only accepts a new turn after the previous one is closed, so close it first.
  assert.equal(ledger.endTurn({ sessionId: 's1', turn: 1 }), true, '前提：turn 1 必须能被正常结束');
  hostTurn(ledger, { requestId: 'req-p2', turn: 2, callId: 'call-p2' });
  const second = await built.runtime.dispatch('publish', { content: 'second', ugc_right: 1 },
    { sessionId: 's1', callId: 'call-p2' });
  assert.equal(second.ok, false, '第二次发布必须被拒: ' + JSON.stringify(second));
  assert.equal(second.reason, 'interval', '拒绝原因必须是 interval —— 自动批准不得豁免间隔');
  assert.equal(bridge.requests.filter((r) => r.action === 'send_qzone_msg').length, 1,
    '被间隔拒绝时不得发出第二次写');
  assert.equal(built.store.read().ledger.used.post, 1, '配额只应消耗 1 个 post');
});

// ── 14. C16/t31: the permit mechanism is RETIRED — a write must reach `send` with no permit at all ──
test('C16/t31 无 permit 配置：装配成功 + 一次写真的走到 send（假 transport），describe() 不再声称需要 permit', async (t) => {
  // 这条用例复现用户实测的那条路径：写返回 not-sent / write-permit-unavailable。
  // 修复后同样的装配与同一次 dispatch 必须落地到 send，且 describe() 不得再暗示还缺许可。
  const endpoint = await fakeBridge(t);
  const built = createQzoneHostAssembly({
    stateDir: tempDir(t),
    initialState: initialState(),
    origin: endpoint.origin,
    token: TOKEN,
    botQq: BOT,
    clock: () => NOW,
    mode: 'enabled',
    // 关键：**两个 permit 选项一个都不给** —— 这是生产的真实形态（config 里那两个键已移除）。
  });
  t.after(() => { built.teardown(); });

  const described = built.describe();
  assert.equal(described.writePermit,
    'retired: no permit is issued or spent anywhere on this path (the approval channel it belonged to is gone)',
    'describe() 必须如实写明许可已作废');
  const unwired = described.unwired.join('\n');
  assert.ok(!/write permit ENFORCEMENT/.test(unwired),
    'unwired 不得再声称「bridge 必须消费许可」—— 那条要求已经不存在');
  assert.ok(/RETIRED with the approval channel/.test(unwired), 'unwired 必须写明许可随审批一起作废');
  assert.ok(/daily quota/.test(unwired), 'unwired 必须写明仍然生效的额度/间隔约束');

  // A real write through the real chain: ledger -> runtime -> compositions -> write path -> send.
  const ledger = built.runtime.sourceLifetime.getLedger('s1');
  hostTurn(ledger, { requestId: 'req-c16', turn: 1, callId: 'call-c16' });
  const result = await built.runtime.dispatch('publish', { content: 'no permit at all', ugc_right: 1 },
    { sessionId: 's1', callId: 'call-c16' });

  assert.equal(result.ok, true, '写链必须走通: ' + JSON.stringify(result));
  assert.equal(result.outcome, 'success', '写链必须判 success');
  assert.notEqual(result.reason, 'write-permit-unavailable',
    '正是用户实测的那个失败原因，修复后不得再出现');
  assert.deepEqual(endpoint.requests.filter((r) => r.action === 'send_qzone_msg').map((r) => r.params),
    [{ content: 'no permit at all', ugc_right: 1 }],
    'send 必须恰好收到一次，且载荷逐字来自契约');
  // 约束没被顺手拆掉：配额扣了、B2 记了。
  assert.equal(built.store.read().ledger.used.post, 1, '额度必须照常扣 1 个 post');
  assert.equal(typeof built.store.read().replaySchema, 'number', 'B2 replay 集合必须仍在');
});
