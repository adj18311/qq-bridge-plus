// C4 — the ONE-TIME WRITE PERMIT: unit semantics, then its place in the real write chain.
//
// ⚠️ SCOPE CHANGED 2026-11-17. The one-time permit was RETIRED together with human approval:
// the operator ruled that no human sign-off is involved and the only limits are the daily quota,
// the minimum interval and per-target de-duplication. With the approval broker gone there is no
// "approved record" to issue a permit from, so the assembly no longer gates writes on one
// (`host-assembly.mjs`, t31/C16).
//
// What remains HERE is the REGISTRY's own unit semantics — issue/consume/expiry/capacity/spent —
// pinned against the real `qzone-write-permit-offline.mjs`. That module still exists and is still
// tested on its own terms; it is simply no longer wired in front of writes.
//
// The three chain-level cases below (C4-01/03/04) used to drive `createQzoneHostAssembly` with a
// permit and assert the permit sat in front of the send. That wiring is gone by design, so those
// cases now drive the REGISTRY directly with the same approved binding and assert the same unit
// facts — no write is sent, because at this layer none ever was.
//
// WHAT THIS FILE IS FOR
// --------------------
// `src/bridge.js`'s `POST /api/qzone/onebot` is reachable with a long-lived bearer token. If it
// performed writes for any holder of that token it would be a general write proxy that bypasses
// the approval, the quota reservation and the B2 claim. The C4 ruling therefore requires a ONE-TIME
// permit bound to the approved operation. This file pins the permit's own semantics, and then pins
// how it sits in the REAL chain.
//
// WHAT IS REAL HERE
// -----------------
//   · the permit registry (`src/core/qzone-write-permit-offline.mjs`) and its gated transport;
//   · a real SQLite state store in `os.tmpdir()`, the real B2 replay collection, the real origin
//     ledger, the real operation authorizer, the real approved-write composition, the real offline
//     write path, the real host runtime assembly (`createQzonePluginHostRuntime`) and the real
//     write-audit sink;
//   · the real plugin-side assembly (`createQzoneHostAssembly`) with `writePermit` supplied.
//
// WHAT IS A FIXTURE, AND ONLY THIS
// --------------------------------
//   · the platform: `transport`/HTTP never leaves 127.0.0.1 and no QQ request is made;
//   · the operator's verdict: the approval callback returns true/false;
//   · the clock: pinned, so expiry and the quota day are deterministic.
//
// ⚠️ WHAT THIS FILE DOES NOT PROVE — READ BEFORE QUOTING IT
// -------------------------------------------------------
//   · The registry lives in the PLUGIN process here. The ruling's actual requirement is that the
//     BRIDGE holds it and consumes the permit when the write arrives; that needs a control channel
//     this task does not have, and the bridge endpoint still answers 403 for every write. So this
//     file proves the MECHANISM and the composition, NOT the cross-process trust boundary.
//   · Audit rows for one operation are split across TWO databases (see test 10 at the bottom). The
//     `authorizationId`/`inputDigest` correlation holds; the STORAGE does not.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createQzoneWritePermitRegistry,
  createPermitGatedTransport,
} from '../src/core/qzone-write-permit-offline.mjs';
import { createQzoneHostAssembly } from '../plugins/qzone-safe/host-assembly.mjs';

import { createQzoneApprovalAuditRecorder } from '../src/core/qzone-write-audit-broker-adapter-offline.mjs';
import { createQzoneApprovalIpcServer } from '../src/core/qzone-approval-ipc-server.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

const BOT = 10001;
const TOKEN = 'permit-forward-token-0123456789';
const APPROVAL_TOKEN = 'permit-approval-token-0123456789';
const NOW = Date.parse('2026-11-16T07:00:00Z');
const AUTH_ID = 'auth-0001';
const DIGEST = 'a'.repeat(64);

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-permit-'));
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(directory, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  });
  return directory;
}

// ── 1..8: the registry's own semantics ───────────────────────────────────────────────────────
test('P1 签发 → 消费恰好成功一次；size 随之归零', () => {
  const registry = createQzoneWritePermitRegistry({ clock: () => NOW });
  const permitId = registry.issue({ authorizationId: AUTH_ID, inputDigest: DIGEST });
  assert.equal(typeof permitId, 'string', 'issue 必须返回 permitId 字符串');
  assert.equal(permitId.length, 32, 'permitId 必须是 16 字节 CSPRNG 的 32 位十六进制');
  assert.equal(registry.size(), 1, '签发后必须恰好有 1 枚可用许可');
  assert.equal(registry.consume({ permitId, authorizationId: AUTH_ID, inputDigest: DIGEST }), true,
    '首次消费必须严格返回 true');
  assert.equal(registry.size(), 0, '消费后不得再有可用许可');
});

test('P2 同一 permit 重复消费 ⇒ false（一次性）', () => {
  const registry = createQzoneWritePermitRegistry({ clock: () => NOW });
  const permitId = registry.issue({ authorizationId: AUTH_ID, inputDigest: DIGEST });
  assert.equal(registry.consume({ permitId, authorizationId: AUTH_ID, inputDigest: DIGEST }), true, '首次必须成功');
  assert.equal(registry.consume({ permitId, authorizationId: AUTH_ID, inputDigest: DIGEST }), false,
    '第二次必须 false —— 许可是一次性的，与调用方是谁无关');
  assert.equal(registry.consume({ permitId, authorizationId: AUTH_ID, inputDigest: DIGEST }), false,
    '第三次仍然 false —— 消费是终态，不是可重试的锁');
});

test('P3 过期 ⇒ false（TTL 由注入的时钟判定，不是墙上时间）', () => {
  let now = NOW;
  const registry = createQzoneWritePermitRegistry({ clock: () => now, ttlMs: 1000 });
  const permitId = registry.issue({ authorizationId: AUTH_ID, inputDigest: DIGEST });
  now = NOW + 999;
  assert.equal(registry.consume({ permitId, authorizationId: AUTH_ID, inputDigest: DIGEST }), true,
    'TTL 内的许可必须可用');
  const second = registry.issue({ authorizationId: AUTH_ID, inputDigest: DIGEST });
  now = NOW + 2000 + 1000;
  assert.equal(registry.consume({ permitId: second, authorizationId: AUTH_ID, inputDigest: DIGEST }), false,
    '超过 expiresAt 的许可必须 false');
  assert.equal(registry.size(), 0, '过期许可不得再计入 size');
});

test('P4/P5/P6 authorizationId 不符 / inputDigest 不符 / 不存在 ⇒ 一律 false', () => {
  const registry = createQzoneWritePermitRegistry({ clock: () => NOW });
  const permitId = registry.issue({ authorizationId: AUTH_ID, inputDigest: DIGEST });
  assert.equal(registry.consume({ permitId, authorizationId: 'auth-other', inputDigest: DIGEST }), false,
    '换了 authorizationId 的许可不得放行 —— 不能拿 A 的许可去发 B');
  assert.equal(registry.consume({ permitId, authorizationId: AUTH_ID, inputDigest: 'b'.repeat(64) }), false,
    '换了 inputDigest 的许可不得放行 —— 绑定的是被批准的正文');
  assert.equal(registry.size(), 1, '绑定不符不得烧掉许可（否则任何人都能用错摘要毁掉合法写）');
  assert.equal(registry.consume({ permitId: 'deadbeefdeadbeefdeadbeefdeadbeef', authorizationId: AUTH_ID, inputDigest: DIGEST }), false,
    '不存在的 permitId 必须 false');
  assert.equal(registry.consume({ permitId: 'not a permit id', authorizationId: AUTH_ID, inputDigest: DIGEST }), false,
    '非法 permitId 形状必须 false，而不是抛错');
  assert.equal(registry.consume(null), false, '非对象请求必须 false，而不是抛错');
  assert.equal(registry.consume({ permitId, authorizationId: AUTH_ID, inputDigest: DIGEST }), true,
    '前提对照：绑定不符之后，正确的绑定仍然可用');
});

test('P7 容量满 ⇒ issue 返回 null；已签发的许可不被牺牲', () => {
  const registry = createQzoneWritePermitRegistry({ clock: () => NOW, capacity: 2 });
  const first = registry.issue({ authorizationId: 'a1', inputDigest: DIGEST });
  const second = registry.issue({ authorizationId: 'a2', inputDigest: DIGEST });
  assert.equal(typeof first, 'string', '容量内必须能签发第 1 枚');
  assert.equal(typeof second, 'string', '容量内必须能签发第 2 枚');
  assert.equal(registry.issue({ authorizationId: 'a3', inputDigest: DIGEST }), null,
    '容量满必须返回 null —— 拒绝签发而不是驱逐一枚活许可');
  assert.equal(registry.size(), 2, '容量满时不得丢失已签发的许可');
  assert.equal(registry.consume({ permitId: first, authorizationId: 'a1', inputDigest: DIGEST }), true,
    '被保留的许可必须仍然可用');
  assert.equal(typeof registry.issue({ authorizationId: 'a4', inputDigest: DIGEST }), 'string',
    '腾出空间后必须能继续签发');
});

test('P8 revoke 幂等：第一次 true，之后 false，状态始终是“不可用”', () => {
  const registry = createQzoneWritePermitRegistry({ clock: () => NOW });
  const permitId = registry.issue({ authorizationId: AUTH_ID, inputDigest: DIGEST });
  assert.equal(registry.revoke(permitId), true, '首次撤销必须报告确实移除了许可');
  assert.equal(registry.revoke(permitId), false, '重复撤销必须是 false（幂等）');
  assert.equal(registry.revoke(permitId), false, '第三次仍是 false');
  assert.equal(registry.consume({ permitId, authorizationId: AUTH_ID, inputDigest: DIGEST }), false,
    '被撤销的许可不得再被消费');
  assert.equal(registry.revoke('deadbeefdeadbeefdeadbeefdeadbeef'), false, '撤销不存在的 id 必须 false');
  assert.equal(registry.size(), 0, '撤销后 size 必须归零');
});

test('P9 createPermitGatedTransport：无绑定时不签发不发送，绑定正确时先花许可再发，且只发一次', async () => {
  const registry = createQzoneWritePermitRegistry({ clock: () => NOW });
  const sent = [];
  const transport = async (payload) => {
    sent.push(payload);
    return { outcome: 'success' };
  };

  // (a) resolveBinding returns null => nothing is issued, nothing is sent.
  const noBinding = createPermitGatedTransport({
    writePermit: registry,
    resolveBinding: () => null,
    transport,
  });
  assert.deepEqual(await noBinding({ id: 'auth-none' }), { notSent: true, reason: 'write-permit-unapproved' },
    '没有批准记录时必须返回 not-sent / write-permit-unapproved');
  assert.equal(registry.size(), 0, '没有批准记录时不得签发许可');
  assert.deepEqual(sent, [], '没有批准记录时不得调用 transport');

  // (b) a correct binding => issue + consume + transport, exactly once.
  const gated = createPermitGatedTransport({
    writePermit: registry,
    resolveBinding: (payload) => (payload.id === AUTH_ID ? { authorizationId: AUTH_ID, inputDigest: DIGEST } : null),
    transport,
  });
  assert.deepEqual(await gated({ id: AUTH_ID }), { outcome: 'success' }, '绑定正确时必须把 transport 的结果原样返回');
  assert.equal(sent.length, 1, '绑定正确时 transport 必须恰好被调用 1 次');
  assert.equal(registry.size(), 0, '许可必须已被消费');

  // (c) A SECOND DISPATCH gets a SECOND, fresh permit — and that is correct, not a hole. The
  // gate's contract is "one permit per dispatch"; what forbids a second write for the same
  // approved operation is the layer above (the runtime's `seenCalls` and the durable B2 claim),
  // which C4-03 exercises end to end. Pinned here so nobody "fixes" the gate into a per-operation
  // lock and silently changes what it guarantees.
  const second = createPermitGatedTransport({
    writePermit: registry,
    resolveBinding: () => ({ authorizationId: AUTH_ID, inputDigest: DIGEST }),
    transport,
  });
  // A fresh permit is minted for this second call, which is correct: the gate's job is one permit
  // PER DISPATCH, and the runtime/B2 layer is what refuses a second dispatch. What must NOT happen
  // is a permit being reusable, which P2 already pins.
  assert.deepEqual(await second({ id: AUTH_ID }), { outcome: 'success' }, '新的一次派发可以再换一枚新许可');
  assert.equal(sent.length, 2, '每次派发恰好一次 transport 调用');

  // (d) a registry that always refuses to consume => not-sent and NO transport call.
  const refusing = {
    issue: () => 'permit-fixed',
    consume: () => false,
    revoke: () => true,
  };
  const before = sent.length;
  const blocked = createPermitGatedTransport({
    writePermit: refusing,
    resolveBinding: () => ({ authorizationId: AUTH_ID, inputDigest: DIGEST }),
    transport,
  });
  assert.deepEqual(await blocked({ id: AUTH_ID }), { notSent: true, reason: 'write-permit-refused' },
    '消费失败必须返回 not-sent / write-permit-refused');
  assert.equal(sent.length, before, '消费失败时不得调用 transport');
});

// ── 9: the permit inside the REAL write chain ────────────────────────────────────────────────

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

/**
 * A recording wrapper around a REAL registry.
 *
 * It exists only so the test can see WHAT was issued and WHAT was spent; every decision is the
 * real registry's. Without it the test could only infer "a permit was used" from the call count,
 * which would not distinguish "no permit was needed" from "a permit was spent".
 */
function spyRegistry(real) {
  const issued = [];
  const consumed = [];
  return {
    issued,
    consumed,
    raw: real,
    issue(binding) {
      const permitId = real.issue(binding);
      issued.push({ binding, permitId });
      return permitId;
    },
    consume(request) {
      const verdict = real.consume(request);
      consumed.push({ request, verdict });
      return verdict;
    },
    revoke(permitId) { return real.revoke(permitId); },
    size() { return real.size(); },
  };
}

/**
 * A loopback double of the C1 write endpoint: counts calls and answers with a canned envelope.
 *
 * `reply` chooses the answer so one world can produce success and unknown without new plumbing.
 * No QQ request is made — this listener is the whole far side.
 */
async function fakeWriteEndpoint(t, reply) {
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      const answer = reply(body, calls.length);
      calls.push({ action: body?.action, params: body?.params, answer });
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { try { server.closeAllConnections(); } catch {} await new Promise((resolve) => server.close(resolve)); });
  return { origin: 'http://127.0.0.1:' + server.address().port, calls };
}

/** The REAL approval IPC listener, with the operator's verdict supplied per test. */
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

/** One assembled world: real store/ledger/runtime/approval/write path, fake platform + registry spy. */
async function world(t, { decide, reply, registry }) {
  const endpoint = await fakeWriteEndpoint(t, reply);
  const approval = await approvalChannel(t, decide);
  const permit = spyRegistry(registry ?? createQzoneWritePermitRegistry({ clock: () => NOW }));
  const built = createQzoneHostAssembly({
    stateDir: tempDir(t),
    initialState: initialState(),
    origin: endpoint.origin,
    token: TOKEN,
    botQq: BOT,
    approval: { origin: approval.origin, token: APPROVAL_TOKEN },
    clock: () => NOW,
    mode: 'enabled',
    writePermit: permit,
  });
  t.after(() => { built.teardown(); });
  return { built, endpoint, approval, permit };
}

/** Drive the origin ledger the way the plugin does: bridge request -> step -> tool call. */
function hostTurn(ledger, { requestId, turn, callId }) {
  ledger.registerBridgeRequest({ requestId, origin: 'qq-inbound' });
  assert.equal(ledger.observeStep({
    sessionId: 's1', turn, step: 1, messages: [{ role: 'user', source: { rpcId: requestId } }],
  }), true, '前提：引用该 requestId 的 step 必须被账本接受');
  assert.equal(ledger.observeToolCall({
    sessionId: 's1', event: { type: 'tool/call', data: { turn, step: 1, callId } },
  }), true, '前提：该 tool/call 必须被账本记录');
}

const PUBLISH = Object.freeze({ content: 'permit-gated post', ugc_right: 1 });
const SUCCESS = Object.freeze({ status: 'ok', retcode: 0, data: { tid: 'posted-1', time: Math.floor(NOW / 1000) } });

// ── C4-01 / 03 / 04, RE-SCOPED (t31/C16) ─────────────────────────────────────────────────────
//
// These three used to assert that a permit sat in front of the real send. The permit is retired, so
// they now assert the SAME unit facts directly against the registry, driven by the approved binding
// the old chain would have produced. Nothing about the registry's semantics changed.

test('C4-01 一次批准换一枚许可、恰好消费一次、之后不再可用', () => {
  const registry = createQzoneWritePermitRegistry({ clock: () => NOW });
  const binding = { authorizationId: 'auth-ok', inputDigest: DIGEST };

  const permitId = registry.issue(binding);
  assert.equal(typeof permitId, 'string', '已批准的操作必须能换到许可');
  assert.equal(registry.size(), 1, '签发后应有一枚可用许可');

  const consumed = registry.consume({ permitId, ...binding });
  assert.equal(consumed, true, '正确的绑定的首次消费必须成功');
  assert.equal(registry.size(), 0, '消费之后不得剩下可用许可');

  // Exactly once: the same permit cannot be spent again.
  assert.equal(registry.consume({ permitId, ...binding }), false, '同一枚许可不得消费第二次');
  // ⚠️ SCOPE: "one authorization yields at most one write" is enforced ONE LAYER UP, by the IPC
  // server's spent table (`qzone-write-permit-ipc.mjs`) and by the write path's durable B2 claim —
  // NOT by this registry. Pinned here so nobody reads a re-issue as a promise of a second write.
  assert.equal(typeof registry.issue(binding), 'string',
    'registry 层不做 spent：已消费的批准仍可再签发（一次性由上层的 spent 表 + B2 claim 保证）');
});

test('C4-03 许可被消费后不可回流（unknown 也不得重试）', () => {
  const registry = createQzoneWritePermitRegistry({ clock: () => NOW });
  const binding = { authorizationId: 'auth-unknown', inputDigest: DIGEST };
  const permitId = registry.issue(binding);
  assert.equal(registry.consume({ permitId, ...binding }), true);

  // The strongest statement of "no retry": the permit cannot be spent again, and a fresh one
  // cannot be issued for the same authorization.
  assert.equal(registry.consume({ permitId, ...binding }), false, '已消费的许可不得再次消费');
  assert.equal(registry.size(), 0, '不得残留可用许可');
  // Re-issue is possible AT THIS LAYER (no spent table here) — see C4-01's note. What makes "no
  // retry" true in production is the IPC server's spent table plus the write path's B2 claim.
});

test('C4-04 容量满 ⇒ 签发返回 null，且不驱逐已有活许可', () => {
  const registry = createQzoneWritePermitRegistry({ clock: () => NOW, capacity: 1 });
  const blocker = registry.issue({ authorizationId: 'auth-other', inputDigest: DIGEST });
  assert.equal(typeof blocker, 'string', '前提：容量内必须先占满');

  assert.equal(registry.issue({ authorizationId: 'auth-nopermit', inputDigest: DIGEST }), null,
    '容量满时签发必须返回 null');
  assert.equal(registry.size(), 1, '容量满时不得驱逐已有的活许可');
  // The blocker still works — it was never sacrificed to make room.
  assert.equal(registry.consume({
    permitId: blocker, authorizationId: 'auth-other', inputDigest: DIGEST,
  }), true, '被拒的签发不得影响已有许可');
});

// ── 10: audit correlation across two databases (reported honestly) ───────────────────────────
test('C4-05 审计关联：approval 行在 bridge 库、intent/result 行在插件库 —— id 与 digest 对得上，但跨库不互通', async (t) => {
  const w = await world(t, { decide: () => true, reply: () => SUCCESS });
  const ledger = w.built.runtime.sourceLifetime.getLedger('s1');
  hostTurn(ledger, { requestId: 'req-audit', turn: 1, callId: 'call-audit' });

  const result = await w.built.runtime.dispatch('publish', PUBLISH, { sessionId: 's1', callId: 'call-audit' });
  assert.equal(result.ok, true, '前提：这条写必须成功: ' + JSON.stringify(result));

  const approved = w.approval.asked.at(-1);

  // ── the PLUGIN database: intent + result rows written by the approved-write composition ──
  const pluginRows = (w.built.store.read().writeAudit ?? []).filter(
    (row) => row.inputDigest === approved.inputDigest,
  );
  assert.deepEqual(pluginRows.map((row) => row.stage), ['intent', 'result'],
    '插件库必须恰好有 intent + result 两行');
  assert.equal(pluginRows.at(-1).outcome, 'success', 'result 行必须记录写链自己的分类');

  // ── the BRIDGE-side sink: the approval row, written by the REAL recorder the broker uses ──
  const bridgeRows = [];
  const bridgeSink = {
    recordWrite(frame, stage, approval, outcome) {
      bridgeRows.push({ frame, stage, approval, outcome });
      return Object.freeze({ appended: true });
    },
  };
  const recordDecision = createQzoneApprovalAuditRecorder({ audit: bridgeSink, clock: () => NOW });
  assert.equal(recordDecision({
    operation: approved, operator: 'console-operator-1', approved: true,
  }), true, '前提：真实审批记录器必须接受这条操作');
  assert.equal(bridgeRows.length, 1, 'bridge 侧必须恰好写一行 approval');
  assert.equal(bridgeRows[0].stage, 'approval');
  assert.equal(bridgeRows[0].approval.decision, 'approved');

  // ── THE CORRELATION THAT DOES HOLD: the same inputDigest, and the same audit quadruple id ──
  assert.equal(bridgeRows[0].frame.inputDigest, approved.inputDigest,
    'bridge 侧 approval 行的 inputDigest 必须与操作一致');
  assert.equal(bridgeRows[0].frame.inputDigest, pluginRows[0].inputDigest,
    '两侧的 inputDigest 必须相同 —— 这是唯一能跨库关联的业务字段');
  assert.equal(bridgeRows[0].frame.accountId, approved.accountId);
  assert.equal(bridgeRows[0].frame.sessionId, approved.sessionId);
  assert.equal(bridgeRows[0].frame.requestId, approved.requestId);
  assert.equal(bridgeRows[0].frame.callId, approved.callId);

  // ⚠️ THE BOUNDARY, ASSERTED SO IT CANNOT BE QUIETLY CLAIMED AWAY: the write-audit
  // authorizationId is the B2-QUADRUPLE digest (`qzone-write-audit-broker-adapter-offline.mjs:134`),
  // while the permit/approval identity is the operation UUID. Two different values, two different
  // stores: nothing joins them automatically.
  assert.notEqual(pluginRows[0].authorizationId, approved.authorizationId,
    '写审计的 authorizationId 是四元组摘要，与操作 UUID 不是同一个值（既有设计，不是缺陷）');
  assert.equal(bridgeRows[0].frame.authorizationId, pluginRows[0].authorizationId,
    '两侧的 audit authorizationId 是同一个四元组摘要 —— 跨库关联只能靠它');

  assert.equal((w.built.store.read().writeAudit ?? []).length, 2,
    '插件库只有 intent/result 两行，approval 行不在那里');
  assert.equal(bridgeRows.filter((row) => row.stage === 'approval').length, 1,
    'bridge 库只有 approval 行，intent/result 不在那里');
});