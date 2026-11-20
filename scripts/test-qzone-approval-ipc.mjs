// I1 · cross-process approval channel — protocol, loopback listener, loopback client.
//
// WHAT IS REAL HERE AND WHAT IS FAKE
// ----------------------------------
//   REAL: node:http (a per-test listener on an ephemeral 127.0.0.1 port), undici fetch, the
//         protocol module, the server module, the client module, and — in the composition test —
//         the REAL authorizer, the REAL approval broker (its decide() is the operator's click) and
//         the REAL origin ledger, so the operation shape on the wire is the one production would
//         carry, not a fixture that happens to fit.
//   FAKE: the broker in the matrix tests below ('fakeBroker'), which records every call and
//         returns whatever the case needs. Also fake: the clock, and the token (minted per run).
//   NEVER: no QQ/OneBot/SnowLuma traffic, no config.json, no state/ files — everything is an
//         ephemeral loopback port and an os.tmpdir() SQLite file.
//
// WHAT THE CHANNEL DOES AND DOES NOT GUARANTEE
// --------------------------------------------
//   · It guarantees: one authorizationId cannot occupy two broker slots while it is in flight
//     (the second ask is answered 'approved:false' without a second broker call), and an unknown
//     outcome (timeout, disconnect) resolves 'false' WITHOUT a retry.
//   · The isolation the cases rely on is MANUFACTURED here: every listener binds an ephemeral
//     127.0.0.1 port, the bearer token is 'randomBytes(32)' minted per run and held only in
//     memory, and no case ever prints, stores or asserts on it.
//   · It does NOT guarantee "exactly one platform write". That is the durable B2 claim's job
//     ('authorizer.claim'); this file never claims otherwise, and no test name below says so.
//   · The digest correlation checked here is "the digest describes the body in the same frame".
//     The authoritative correlation against the authorizer's frozen snapshot and branded
//     consumption happens in-process in the broker's 'recordDecision' recorder, which cannot see
//     across the process boundary — spelled out in the protocol module's header.

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  QZONE_APPROVAL_IPC_MAX_FRAME_BYTES,
  QZONE_APPROVAL_IPC_PATH,
  parseQzoneApprovalRequestFrame,
  readQzoneApprovalResponseFrame,
  serializeQzoneApprovalRequestFrame,
} from '../src/core/qzone-approval-ipc-protocol.mjs';
import { createQzoneApprovalIpcServer } from '../src/core/qzone-approval-ipc-server.mjs';
import { createQzoneApprovalIpcClient } from '../src/core/qzone-approval-ipc-client.mjs';
import { createQzoneOperationApprovalBroker } from '../src/core/qzone-operation-approval-console.mjs';
import { createQzoneOperationAuthorizer } from '../src/core/qzone-operation-authorization-offline.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import {
  _writeAuditInputDigest,
  createQzoneApprovalAuditRecorder,
} from '../src/core/qzone-write-audit-broker-adapter-offline.mjs';
import { validateQzoneMcpInput } from '../src/core/qzone-mcp-contract.mjs';

const NOW = 1_800_000_000_000;
const TTL = 30_000;
/** Minted per run, in memory only. Never read from config/env; never logged or asserted on. */
const TOKEN = randomBytes(32).toString('base64url');

/** A fresh authorizationId per ask, so tests never collide by accident. */
let sequence = 0;
const nextId = () => 'auth-ipc-' + (++sequence);

/**
 * The operation shape the real authorizer mints
 * ('qzone-operation-authorization-offline.mjs:371-384'), with a digest that really is the digest
 * of 'input' — a fixture with a made-up digest would be refused by the protocol layer and would
 * test nothing.
 */
function makeOperation(overrides = {}) {
  const input = overrides.input ?? { content: 'hello qzone', ugc_right: 1 };
  return Object.freeze({
    accountId: 123,
    sessionId: 's1',
    requestId: 'r1',
    callId: 'c1',
    sourceEpoch: 'e1',
    connectionEpoch: 0,
    origin: 'qq-inbound',
    action: 'publish',
    input: Object.freeze(input),
    inputDigest: _writeAuditInputDigest(input),
    authorizationId: nextId(),
    expiresAt: NOW + TTL,
    ...overrides,
    // 'overrides' may pass a digest for a negative case; recompute only when it did not.
    ...(overrides.inputDigest === undefined && overrides.input !== undefined
      ? { inputDigest: _writeAuditInputDigest(overrides.input) }
      : {}),
  });
}

/** A broker whose verdict every case controls, recording each operation it was asked about. */
function fakeBroker(verdict = true) {
  const calls = [];
  return {
    calls,
    approveOperation(operation) {
      calls.push(operation);
      return typeof verdict === 'function' ? verdict(operation) : verdict;
    },
  };
}

/** A promise that never settles: the "operator never clicks" case. */
const never = () => new Promise(() => {});

/**
 * Boot a listener and a client against it.
 *
 * Everything the case needs to clean up is registered on 't.after' in reverse order, so the client
 * is closed before the listener and the port is free when the test ends.
 */
async function boot(t, options = {}) {
  const broker = options.broker ?? fakeBroker();
  const server = await createQzoneApprovalIpcServer({
    broker,
    token: TOKEN,
    clock: options.serverClock ?? (() => NOW),
    timeoutMs: options.serverTimeoutMs ?? 5_000,
    maxInflight: options.maxInflight ?? 8,
  });
  t.after(() => server.close());
  const origin = 'http://127.0.0.1:' + server.port;
  const client = options.clientOverride === undefined
    ? createQzoneApprovalIpcClient({
      origin,
      token: options.clientToken ?? TOKEN,
      clock: () => NOW,
      timeoutMs: options.clientTimeoutMs ?? 3_000,
    })
    : options.clientOverride(origin, server);
  if (client !== null) t.after(() => client.close());
  return { broker, server, client, origin };
}

/** One raw POST, so a case can send a body the client would never build. */
async function rawPost(origin, { path = QZONE_APPROVAL_IPC_PATH, method = 'POST', token = TOKEN, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(origin + path, {
    method, headers, body: typeof body === 'string' || body === undefined ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* a non-JSON body is itself an observation */ }
  return { status: response.status, text, body: parsed };
}

/** True only for the closed approval frame — the same reader the client uses. */
const isApproved = (body) => readQzoneApprovalResponseFrame(body) === true;

// ---------------------------------------------------------------------------------------------
// The positive path
// ---------------------------------------------------------------------------------------------

test('IPC-1 正常批准：帧通过校验、broker 被问一次、客户端拿到 strict true', async (t) => {
  const verdicts = [];
  const broker = fakeBroker(() => { verdicts.push(true); return true; });
  const { client } = await boot(t, { broker });
  const operation = makeOperation();
  assert.equal(await client.approveOperation(operation), true, '★ 严格 true');
  assert.equal(broker.calls.length, 1, '★ broker 只被问一次');
  assert.equal(broker.calls[0].authorizationId, operation.authorizationId);
  assert.equal(broker.calls[0].inputDigest, operation.inputDigest);
  assert.deepEqual(broker.calls[0].input, { content: 'hello qzone', ugc_right: 1 });
  assert.equal(verdicts.length, 1);
});

test('IPC-2 broker 说 false ⇒ 客户端 false（响应是 200 + approved:false，不是错误码）', async (t) => {
  const broker = fakeBroker(false);
  const { client, origin } = await boot(t, { broker });
  assert.equal(await client.approveOperation(makeOperation()), false);
  assert.equal(broker.calls.length, 1);
  const operation = makeOperation();
  const direct = await rawPost(origin, {
    body: { authorizationId: operation.authorizationId, inputDigest: operation.inputDigest, operation },
  });
  assert.equal(direct.status, 200, '★ 拒绝是一次正常回答，不是 HTTP 错误');
  assert.equal(isApproved(direct.body), false);
});

test('IPC-3 令牌不符 / 缺失 / 形状不同 ⇒ 401，且 broker 完全没被调用', async (t) => {
  const broker = fakeBroker(true);
  const { client, origin } = await boot(t, { broker });
  assert.equal(await client.approveOperation(makeOperation()), true, '前提：正确令牌可用');
  assert.equal(broker.calls.length, 1);
  const operation = makeOperation();
  const frame = { authorizationId: operation.authorizationId, inputDigest: operation.inputDigest, operation };
  for (const token of ['x'.repeat(48), null, '']) {
    const answer = await rawPost(origin, { token, body: frame });
    assert.equal(answer.status, 401, '★ 错误令牌 = 401');
    assert.equal(isApproved(answer.body), false);
  }
  // A token that differs only in length is refused before any comparison.
  assert.equal((await rawPost(origin, { token: TOKEN + 'x', body: frame })).status, 401);
  assert.equal(broker.calls.length, 1, '★ 401 的请求没有触达 broker');

  // The same thing seen from the CLIENT's side: a client holding the wrong token is simply false.
  const wrong = createQzoneApprovalIpcClient({
    origin, token: 'not-the-token-' + 'y'.repeat(20), clock: () => NOW, timeoutMs: 2_000,
  });
  t.after(() => wrong.close());
  assert.equal(await wrong.approveOperation(makeOperation()), false, '★ 令牌错误的客户端 = false');
  assert.equal(broker.calls.length, 1, '★ 仍然零新增入队');
});

test('IPC-4 路径错 ⇒ 404，方法错 ⇒ 405，两者都不触达 broker', async (t) => {
  const broker = fakeBroker(true);
  const { origin } = await boot(t, { broker });
  const operation = makeOperation();
  const frame = { authorizationId: operation.authorizationId, inputDigest: operation.inputDigest, operation };
  assert.equal((await rawPost(origin, { path: '/approve/../decide', body: frame })).status, 404);
  assert.equal((await rawPost(origin, { path: '/decide', body: frame })).status, 404);
  assert.equal((await rawPost(origin, { path: '/', body: frame })).status, 404);
  const wrongMethod = await rawPost(origin, { method: 'GET', body: undefined });
  assert.equal(wrongMethod.status, 405, '★ GET /approve = 405');
  const put = await rawPost(origin, { method: 'PUT', body: frame });
  assert.equal(put.status, 405);
  assert.equal(broker.calls.length, 0, '★ 路由/方法错误都没有触达 broker');
});

// ---------------------------------------------------------------------------------------------
// The unknown-outcome cases: never retried, never thrown
// ---------------------------------------------------------------------------------------------

test('IPC-5 超时：broker 永挂 ⇒ 客户端在 timeoutMs 后拿到 false，不 throw，服务端票据不被取消', async (t) => {
  const cancelled = [];
  const broker = {
    approveOperation() { return never(); },
    cancel(id) { cancelled.push(id); },
  };
  const { client } = await boot(t, { broker, clientTimeoutMs: 250, serverTimeoutMs: 5_000 });
  const started = Date.now();
  let verdict;
  let thrown = null;
  try {
    verdict = await client.approveOperation(makeOperation());
  } catch (error) {
    thrown = error;
  }
  const elapsed = Date.now() - started;
  assert.equal(thrown, null, '★ 超时不向外抛');
  assert.equal(verdict, false, '★ 超时 = false');
  assert.ok(elapsed >= 200, '实际等了客户端预算：' + elapsed + 'ms');
  assert.ok(elapsed < 2_000, '没有拖到服务端预算：' + elapsed + 'ms');
  assert.deepEqual(cancelled, [], '★ 客户端不会去"取消"host 的票据（它也没有这个入口）');
});

test('IPC-5b 服务端自己的预算同样收敛为 false（broker 永挂 + 客户端更耐心）', async (t) => {
  const broker = { approveOperation() { return never(); } };
  const { client, origin } = await boot(t, { broker, clientTimeoutMs: 5_000, serverTimeoutMs: 250 });
  const started = Date.now();
  assert.equal(await client.approveOperation(makeOperation()), false, '★ 服务端超时也答 false');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, '服务端预算生效，耗时 ' + elapsed + 'ms');
  const operation = makeOperation();
  const direct = await rawPost(origin, {
    body: { authorizationId: operation.authorizationId, inputDigest: operation.inputDigest, operation },
  });
  assert.equal(direct.status, 200, '★ 服务端超时是一次正常回答，不是 500');
  assert.equal(isApproved(direct.body), false);
});

test('IPC-6 断连：server 关闭后再发 ⇒ false，不重试', async (t) => {
  const broker = fakeBroker(true);
  const { client, server } = await boot(t, { broker });
  assert.equal(await client.approveOperation(makeOperation()), true, '前提：连接正常时可用');
  assert.equal(broker.calls.length, 1);
  await server.close();
  const started = Date.now();
  assert.equal(await client.approveOperation(makeOperation()), false, '★ 连接被拒 = false');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_500, '立即失败而不是等到超时：' + elapsed + 'ms');
  assert.equal(broker.calls.length, 1, '★ 断连后没有补投出第二次 broker 调用');
});

test('IPC-6b 中途断连（响应未发出就关闭）⇒ false，且不会在重连后补投', async (t) => {
  const broker = fakeBroker(() => {
    // The listener is closed while this ask is still pending: the client sees the socket die.
    setImmediate(() => { serverRef.close().catch(() => {}); });
    return new Promise(() => {});
  });
  let serverRef;
  const { client, server } = await boot(t, { broker, clientTimeoutMs: 3_000, serverTimeoutMs: 5_000 });
  serverRef = server;
  assert.equal(await client.approveOperation(makeOperation()), false, '★ 半途断连 = false');
  assert.equal(broker.calls.length, 1);
  // The client keeps no queue: asking again on the dead endpoint is a NEW request that fails.
  assert.equal(await client.approveOperation(makeOperation()), false);
  assert.equal(broker.calls.length, 1, '★ 没有补投');
});

test('IPC-6c 客户端 close() 会中止在途请求，并让它收敛为 false', async (t) => {
  const broker = { approveOperation() { return never(); } };
  const { client } = await boot(t, { broker, clientTimeoutMs: 10_000, serverTimeoutMs: 10_000 });
  const waiting = client.approveOperation(makeOperation());
  await new Promise((resolve) => setTimeout(resolve, 100));
  await client.close();
  assert.equal(await waiting, false, '★ close() 让在途请求得到 false');
  assert.equal(await client.approveOperation(makeOperation()), false, '关闭后的客户端不再发请求');
});

// ---------------------------------------------------------------------------------------------
// Duplicate authorizationId — a QUEUE property, not an "exactly once write" property
// ---------------------------------------------------------------------------------------------

test('IPC-7 同一 authorizationId 并发 ⇒ broker 只入队一次；重复的那次直接 false', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const broker = fakeBroker(() => gate.then(() => true));
  const { client, origin } = await boot(t, { broker, clientTimeoutMs: 5_000, serverTimeoutMs: 10_000 });
  const operation = makeOperation();

  // (a) through the client: the second call shares the first promise, so one wire request exists.
  const first = client.approveOperation(operation);
  const second = client.approveOperation(operation);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(broker.calls.length, 1, '★ 客户端并发只发一次');

  // (b) through raw HTTP, while the broker is still holding the first ask: the listener answers
  // false and does not enqueue a second ticket.
  const frame = { authorizationId: operation.authorizationId, inputDigest: operation.inputDigest, operation };
  const duplicate = await rawPost(origin, { body: frame });
  assert.equal(duplicate.status, 200);
  assert.equal(isApproved(duplicate.body), false, '★ 在途重复 = approved:false');
  assert.equal(broker.calls.length, 1, '★ 在途重复没有产生第二次 broker.approveOperation');

  release();
  assert.equal(await first, true);
  assert.equal(await second, true, '并发调用共享同一个答案');
  assert.equal(broker.calls.length, 1);

  // The in-flight entry is gone once the ask settles: a repeat is sent again and the HOST answers
  // (here: fake broker true). This channel does not dedupe settled ids — the broker does.
  assert.equal(await client.approveOperation(operation), true);
  assert.equal(broker.calls.length, 2, '结算后的再次询问会重新到达 broker（去重不在本层）');
});

// ---------------------------------------------------------------------------------------------
// Invalid frames: refused before the broker sees anything
// ---------------------------------------------------------------------------------------------

test('IPC-21 同一 authorizationId 但正文不同：并发时直接 false，不借用第一次的答案', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const broker = fakeBroker(() => gate.then(() => true));
  const { client, origin } = await boot(t, { broker, clientTimeoutMs: 5_000, serverTimeoutMs: 10_000 });
  const base = makeOperation();
  const first = client.approveOperation(base);
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Same ticket id, different body: the first ask's verdict must never be handed to it.
  const tampered = makeOperation({ authorizationId: base.authorizationId, input: { content: 'tampered body', ugc_right: 1 } });
  assert.equal(await client.approveOperation(tampered), false, '★ 不同正文不共享答案');
  assert.equal(broker.calls.length, 1, '★ 也没有为它开第二条连接');
  // The SAME listener refuses the in-flight id outright, even for a well-formed frame — so the
  // tampered body cannot be enqueued as a second ticket either.
  const rawFrame = { authorizationId: base.authorizationId, inputDigest: tampered.inputDigest, operation: tampered };
  const answer = await rawPost(origin, { body: rawFrame });
  assert.equal(isApproved(answer.body), false, '★ 同一 id 在途 ⇒ 服务端直接 false');
  assert.equal(broker.calls.length, 1);
  release();
  assert.equal(await first, true);
  assert.equal(broker.calls.length, 1);
});

test('IPC-8 非法帧全部被拒且 broker 零调用（摘要不符 / 多余键 / 缺键 / 类型不符 / 非法 JSON）', async (t) => {
  const broker = fakeBroker(true);
  const { origin } = await boot(t, { broker });
  const good = makeOperation();
  const frame = { authorizationId: good.authorizationId, inputDigest: good.inputDigest, operation: good };
  const cases = [];

  // digest 与正文不符
  cases.push(['digest 与正文不符', { ...frame, operation: makeOperation({ inputDigest: 'a'.repeat(64) }) }]);
  // digest 形状错
  cases.push(['digest 不是 64 位小写 hex', { ...frame, inputDigest: 'A'.repeat(64) }]);
  // 帧顶层多一个键（消费对象无法用任何被接受的键写入 ⇒ 键集封闭就是这条防线）
  cases.push(['帧顶层多一个键', { ...frame, extra: 1 }]);
  cases.push(['帧顶层带 consumption 键', { ...frame, consumption: { epoch: 'e1' } }]);
  cases.push(['operation 里多一个键', { ...frame, operation: { ...good, issuedConsumptions: [] } }]);
  // 缺键
  const { authorizationId: _drop, ...frameMissing } = frame;
  cases.push(['帧缺 authorizationId', frameMissing]);
  const { origin: _drop2, ...operationMissing } = good;
  cases.push(['operation 缺 origin', { ...frame, operation: operationMissing }]);
  // 类型不符
  cases.push(['operation 是数组', { ...frame, operation: [] }]);
  cases.push(['authorizationId 用了非法字符', { ...frame, authorizationId: 'bad id!' }]);
  cases.push(['expiresAt 不是整数', { ...frame, operation: { ...good, expiresAt: 'soon' } }]);
  // 正文不满足工具契约
  cases.push(['正文不是合法 input', { ...frame, operation: makeOperation({ input: { nope: 1 } }) }]);
  // 根本不是 JSON / 空体
  cases.push(['非法 JSON', '{"authorizationId":']);

  for (const [label, body] of cases) {
    const answer = await rawPost(origin, { body });
    assert.ok(answer.status === 400, label + ' ⇒ 400（实际 ' + answer.status + '）');
    assert.equal(isApproved(answer.body), false, label + ' ⇒ 不批准');
  }
  assert.equal(broker.calls.length, 0, '★ 全部非法帧都没有到达 broker');
});

test('IPC-9 超大帧 ⇒ 413，broker 零调用；合法上限内的最大正文仍然通过', async (t) => {
  const broker = fakeBroker(true);
  const { client, origin } = await boot(t, { broker, clientTimeoutMs: 5_000, serverTimeoutMs: 5_000 });

  // Just over the cap. The body is built from an oversized business input, which the client itself
  // refuses to serialize — so this goes out as raw HTTP, exactly like a hostile peer would.
  const oversized = 'x'.repeat(QZONE_APPROVAL_IPC_MAX_FRAME_BYTES + 1024);
  const huge = JSON.stringify({ authorizationId: 'auth-huge', inputDigest: 'a'.repeat(64), operation: { pad: oversized } });
  assert.ok(Buffer.byteLength(huge, 'utf8') > QZONE_APPROVAL_IPC_MAX_FRAME_BYTES);
  const answer = await rawPost(origin, { body: huge });
  assert.equal(answer.status, 413, '★ 超过帧上限 = 413');
  assert.equal(broker.calls.length, 0);

  // The contract allows 100000 characters of content; the cap must not refuse that.
  const maxContent = 'a'.repeat(100_000);
  const operation = makeOperation({ input: { content: maxContent, ugc_right: 1 } });
  assert.equal(await client.approveOperation(operation), true, '★ 契约允许的最大正文不被上限误伤');
  assert.equal(broker.calls.length, 1);
  assert.equal(broker.calls[0].input.content.length, 100_000);
});

test('IPC-10 "consumption" 作为正文内容完全合法（不做字符串黑名单）', async (t) => {
  const broker = fakeBroker(true);
  const { client } = await boot(t, { broker });
  for (const content of ['consumption', 'issuedConsumptions: []', 'looks like {"consumption": {}}']) {
    const operation = makeOperation({ input: { content, ugc_right: 1 } });
    assert.equal(await client.approveOperation(operation), true, '★ 正文含这些词必须是合法业务文本：' + content);
  }
  assert.equal(broker.calls.length, 3);
});

test('IPC-11 过期操作：两端都不发请求（客户端 0 次，服务端也不入队）', async (t) => {
  const broker = fakeBroker(true);
  const { client, origin } = await boot(t, { broker });
  const expired = makeOperation({ expiresAt: NOW - 1 });
  assert.equal(await client.approveOperation(expired), false, '★ 客户端不发已过期的操作');
  assert.equal(broker.calls.length, 0, '★ 没有触达 broker');
  // Same rule on the listener side, for a peer that skipped the client check.
  const frame = { authorizationId: expired.authorizationId, inputDigest: expired.inputDigest, operation: expired };
  const answer = await rawPost(origin, { body: frame });
  assert.equal(answer.status, 200);
  assert.equal(isApproved(answer.body), false);
  assert.equal(broker.calls.length, 0);
});

test('IPC-12 响应帧严格性：只有 { ok:true, approved:true } 才算批准', () => {
  assert.equal(readQzoneApprovalResponseFrame({ ok: true, approved: true }), true);
  const refused = [
    { ok: true, approved: false },
    { ok: true, approved: 'true' },
    { ok: true, approved: 1 },
    { ok: true },
    { approved: true },
    { ok: false, approved: true },
    { ok: true, approved: true, extra: 1 },
    ['true'],
    null,
    'approved',
  ];
  for (const value of refused) assert.equal(readQzoneApprovalResponseFrame(value), false, JSON.stringify(value));
});

test('IPC-13 未知 authorizationId 的并发按 id 分组：两个 id 并发 ⇒ 两次 broker，各得各的答案', async (t) => {
  const gates = new Map();
  const broker = fakeBroker((operation) => new Promise((resolve) => { gates.set(operation.authorizationId, resolve); }));
  const { client } = await boot(t, { broker, clientTimeoutMs: 5_000, serverTimeoutMs: 10_000 });
  const a = makeOperation();
  const b = makeOperation();
  const first = client.approveOperation(a);
  const second = client.approveOperation(b);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(broker.calls.length, 2, '不同 id 是两条独立的询问');
  gates.get(a.authorizationId)(true);
  gates.get(b.authorizationId)(false);
  assert.equal(await first, true);
  assert.equal(await second, false, '★ 每个 id 拿到自己的答案');
});

test('IPC-18 客户端对畸形响应一律 false：非 2xx / 非 JSON / 字段类型不符 / 超长响应体', async (t) => {
  // A raw listener that answers whatever the case needs — the only way to exercise response
  // shapes the real server would never emit.
  const http = await import('node:http');
  let mode = 'approved';
  const rogue = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const send = (status, body) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(body);
      };
      if (mode === 'approved') return send(200, JSON.stringify({ ok: true, approved: true }));
      if (mode === 'string-true') return send(200, JSON.stringify({ ok: true, approved: 'true' }));
      if (mode === 'extra-key') return send(200, JSON.stringify({ ok: true, approved: true, extra: 1 }));
      if (mode === 'not-json') return send(200, '<html>nope</html>');
      if (mode === 'empty') return send(200, '');
      if (mode === '500') return send(500, JSON.stringify({ ok: true, approved: true }));
      if (mode === '404') return send(404, JSON.stringify({ ok: true, approved: true }));
      if (mode === '405') return send(405, JSON.stringify({ ok: true, approved: true }));
      if (mode === '302') return send(302, '');
      if (mode === 'oversize') return send(200, 'x'.repeat(64 * 1024));
      return send(200, JSON.stringify({ ok: false, approved: false }));
    });
  });
  await new Promise((resolve) => rogue.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve));
  const roguePort = rogue.address().port;
  t.after(() => new Promise((resolve) => { rogue.closeAllConnections?.(); rogue.close(() => resolve()); }));
  const client = createQzoneApprovalIpcClient({
    origin: 'http://127.0.0.1:' + roguePort, token: TOKEN, clock: () => NOW, timeoutMs: 2_000,
  });
  t.after(() => client.close());

  assert.equal(await client.approveOperation(makeOperation()), true, '前提：畸形实验里也有一个正常答案');
  // '404'/'405' also cover the client's side of "wrong path / wrong method": a listener that
  // answers those still yields false, never an approval carried in a non-2xx body.
  for (const bad of ['string-true', 'extra-key', 'not-json', 'empty', '404', '405', '500', '302', 'oversize']) {
    mode = bad;
    let thrown = null;
    let verdict;
    try { verdict = await client.approveOperation(makeOperation()); } catch (error) { thrown = error; }
    assert.equal(thrown, null, bad + ' 不抛异常');
    assert.equal(verdict, false, '★ ' + bad + ' ⇒ false');
  }
  mode = 'approved';
  assert.equal(await client.approveOperation(makeOperation()), true, '★ 通道恢复后仍然能批准');
});

test('IPC-19 客户端自身拒绝不可投递的操作（不发请求）', async (t) => {
  const broker = fakeBroker(true);
  const { client } = await boot(t, { broker });
  const bad = [
    makeOperation({ authorizationId: 'bad id with spaces' }),
    makeOperation({ authorizationId: 'x'.repeat(129) }),
    makeOperation({ inputDigest: 'A'.repeat(64) }),
    makeOperation({ input: { content: 'hello', ugc_right: 7 } }),
    { ...makeOperation(), operation: undefined },
  ];
  for (const operation of bad) {
    assert.equal(await client.approveOperation(operation), false, '拒绝不可投递的操作');
  }
  assert.equal(await client.approveOperation(null), false);
  assert.equal(await client.approveOperation(undefined), false);
  assert.equal(broker.calls.length, 0, '★ 一次请求都没有发出');
});

// ---------------------------------------------------------------------------------------------
// Composition with the REAL authorizer + REAL broker + REAL ledger
// ---------------------------------------------------------------------------------------------

test('IPC-14 真实装配：authorizer → 客户端 → 通道 → broker.decide()，一次真实操作走完两端', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qzone-approval-ipc-'));
  const store = openOfflineStore(join(dir, 'state.db'), { audit: [] });
  const cleanupDir = () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  };
  t.after(() => { try { store.close(); } catch {} cleanupDir(); });
  assert.equal(initializeReplayState(store, { now: NOW }).ok, true);

  // The REAL broker: 'decide' is the operator pressing approve, and it is issued by THIS process.
  const decisions = [];
  const broker = createQzoneOperationApprovalBroker({
    clock: () => NOW,
    recordDecision: (decision) => { decisions.push(decision); return true; },
  });
  t.after(() => broker.close());

  const seen = [];
  const listener = await createQzoneApprovalIpcServer({
    broker: { approveOperation: (operation) => { seen.push(operation); return broker.approveOperation(operation); } },
    token: TOKEN,
    clock: () => NOW,
    timeoutMs: 5_000,
  });
  t.after(() => listener.close());
  const client = createQzoneApprovalIpcClient({
    origin: 'http://127.0.0.1:' + listener.port,
    token: TOKEN,
    clock: () => NOW,
    timeoutMs: 5_000,
  });
  t.after(() => client.close());

  const ledger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: 'r1', origin: 'qq-inbound' });
  assert.equal(ledger.observeStep({ sessionId: 's1', turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'r1' } }] }), true);
  assert.equal(ledger.observeToolCall({ sessionId: 's1', event: { type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c1' } } }), true);
  const consumption = ledger.consume({ sessionId: 's1', turn: 1, step: 1, callId: 'c1' });

  const authorizer = createQzoneOperationAuthorizer({
    store,
    accountId: 123,
    sourceEpoch: 'e1',
    clock: () => NOW,
    approveOperation: client.approveOperation,
    isCurrent: () => true,
  });

  const waiting = authorizer.prepare({
    action: 'publish',
    input: { content: 'hello qzone', ugc_right: 1 },
    consumption,
    connectionEpoch: 0,
  });

  // Wait until the ask has crossed the channel and the broker is holding the ticket.
  for (let spin = 0; spin < 200 && broker.listPending().length === 0; spin += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const pending = broker.listPending();
  assert.equal(pending.length, 1, '★ 操作跨进程后进入 broker 的待审队列');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, 'publish', '★ 服务端看到的是同一个 operation');
  assert.deepEqual(seen[0].input, { content: 'hello qzone', ugc_right: 1 });
  assert.equal(typeof seen[0].inputDigest, 'string');
  assert.equal(seen[0].inputDigest, pending[0].inputDigest);
  // The wire carries no consumption: the branded object cannot cross, and the server only ever
  // sees the frozen operation the authorizer put on the wire.
  assert.equal(Object.hasOwn(seen[0], 'consumption'), false);
  assert.deepEqual(Object.keys(seen[0]).sort(), [
    'accountId', 'action', 'authorizationId', 'callId', 'connectionEpoch', 'expiresAt', 'input',
    'inputDigest', 'origin', 'requestId', 'sessionId', 'sourceEpoch',
  ]);

  // Operator approves through the broker; the verdict travels back over the channel.
  assert.equal(broker.decide({
    authorizationId: pending[0].authorizationId,
    inputDigest: pending[0].inputDigest,
    approved: true,
  }, { operator: 'console-session-1' }), true);

  const ticket = await waiting;
  assert.notEqual(ticket, null, '★ 批准后 authorizer 拿到票据');
  // A ticket is opaque ('{ operation }') and 'verify' lives on the authorizer, not on the ticket
  // ('qzone-operation-authorization-offline.mjs:396,411'). The consumption is passed by reference.
  const expected = { action: 'publish', input: { content: 'hello qzone', ugc_right: 1 }, consumption, connectionEpoch: 0 };
  assert.equal(authorizer.verify(ticket, expected), true, '★ 票据绑定的是被批准的那份操作');
  assert.equal(authorizer.verify(ticket, { ...expected, input: { content: 'other', ugc_right: 1 } }), false,
    '★ 正文不符的票据不被认可');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].approved, true);
});

test('IPC-20 T-超时撤回：监听器超时 ⇒ 票据立即撤回、listPending 空、decide 拒绝、审计 0 行', async (t) => {
  // The REAL broker with the REAL audit recorder behind an in-memory sink, so "no audit row" is
  // measured against the same code path that would write one.
  const auditRows = [];
  const auditSink = {
    recordWrite(frame, stage, decision, outcome) {
      auditRows.push({ stage, decision: decision?.decision ?? null, outcome: outcome ?? null });
    },
  };
  const recorder = createQzoneApprovalAuditRecorder({ audit: auditSink, clock: () => NOW });
  const decisions = [];
  const broker = createQzoneOperationApprovalBroker({
    clock: () => NOW,
    recordDecision: (decision) => { decisions.push(decision); return recorder(decision); },
  });
  t.after(() => broker.close());
  const listener = await createQzoneApprovalIpcServer({
    broker, token: TOKEN, clock: () => NOW, timeoutMs: 200,
  });
  t.after(() => listener.close());
  const client = createQzoneApprovalIpcClient({
    origin: 'http://127.0.0.1:' + listener.port, token: TOKEN, clock: () => NOW, timeoutMs: 3_000,
  });
  t.after(() => client.close());

  const operation = makeOperation();
  const started = Date.now();
  assert.equal(await client.approveOperation(operation), false, '★ 服务端预算到期 ⇒ false');
  assert.ok(Date.now() - started < 2_000, '服务端预算确实生效');

  // The ask was abandoned, so the listener withdrew the ticket: nothing left to click on the
  // operator's console, and no second ask can find it either.
  assert.deepEqual(broker.listPending(), [], '★★ 超时后票据必须已被撤回（listPending 为空）');
  assert.equal(await client.approveOperation(operation), false, '★ 重复询问 = false（票据已不在）');
  assert.deepEqual(broker.listPending(), [], '★ 重复询问也没有把它重新入队');

  // A late approval is now IMPOSSIBLE, not merely harmless.
  assert.equal(broker.decide({
    authorizationId: operation.authorizationId,
    inputDigest: operation.inputDigest,
    approved: true,
  }, { operator: 'console-session-1' }), false, '★★★ 票据已撤回 ⇒ 迟到 decide 返回 false');
  assert.deepEqual(decisions, [], '★★ recordDecision 一次都没被调用：撤回不是决定');
  assert.deepEqual(auditRows, [], '★★★ 撤回不写任何审计行（不伪造 rejected，也不产生 approved）');
});

test('IPC-15 真实装配的否定面：操作员拒绝 ⇒ authorizer 得到 null（通道返回 false 的后果）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qzone-approval-ipc-no-'));
  const store = openOfflineStore(join(dir, 'state.db'), { audit: [] });
  const cleanupDir = () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  };
  t.after(() => { try { store.close(); } catch {} cleanupDir(); });
  assert.equal(initializeReplayState(store, { now: NOW }).ok, true);
  const broker = createQzoneOperationApprovalBroker({ clock: () => NOW });
  t.after(() => broker.close());
  const listener = await createQzoneApprovalIpcServer({
    broker, token: TOKEN, clock: () => NOW, timeoutMs: 5_000,
  });
  t.after(() => listener.close());
  const client = createQzoneApprovalIpcClient({
    origin: 'http://127.0.0.1:' + listener.port, token: TOKEN, clock: () => NOW, timeoutMs: 5_000,
  });
  t.after(() => client.close());

  const ledger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: 'r1', origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: 's1', turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'r1' } }] });
  ledger.observeToolCall({ sessionId: 's1', event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1' } } });
  const consumption = ledger.consume({ sessionId: 's1', turn: 1, step: 1, callId: 'c1' });
  const authorizer = createQzoneOperationAuthorizer({
    store, accountId: 123, sourceEpoch: 'e1', clock: () => NOW,
    approveOperation: client.approveOperation, isCurrent: () => true,
  });
  const waiting = authorizer.prepare({
    action: 'publish', input: { content: 'hello qzone', ugc_right: 1 }, consumption, connectionEpoch: 0,
  });
  for (let spin = 0; spin < 200 && broker.listPending().length === 0; spin += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const [pending] = broker.listPending();
  assert.equal(broker.decide({
    authorizationId: pending.authorizationId, inputDigest: pending.inputDigest, approved: false,
  }, { operator: 'console-session-1' }), true);
  assert.equal(await waiting, null, '★ 拒绝 ⇒ 没有票据');
});

// ---------------------------------------------------------------------------------------------
// LATE APPROVAL — measured, not assumed
// ---------------------------------------------------------------------------------------------

test('IPC-22 broker 自带过期定时器：票据在 expiresAt 自行关闭（不是靠 HTTP 断开）', async () => {
  // A real clock and a short expiry: the broker arms 'setTimeout(() => finish(id,false),
  // expiresAt - now)' ('qzone-operation-approval-console.mjs:54'). This is the mechanism the
  // listener relies on when it answers 'approved:false' on timeout without cancelling anything.
  const realNow = () => Date.now();
  const broker = createQzoneOperationApprovalBroker({ clock: realNow });
  try {
    const operation = makeOperation({ expiresAt: realNow() + 150 });
    const started = Date.now();
    const waiting = broker.approveOperation(operation);
    assert.equal(broker.listPending().length, 1, '前提：票据已入队');
    assert.equal(await waiting, false, '★ 到点自行关闭 ⇒ false');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 100, '确实等到了 expiresAt（' + elapsed + 'ms）');
    assert.ok(elapsed < 2_000, '不是别的路径关掉的（' + elapsed + 'ms）');
    assert.deepEqual(broker.listPending(), [], '★ 过期后票据消失');
    assert.equal(broker.decide({
      authorizationId: operation.authorizationId, inputDigest: operation.inputDigest, approved: true,
    }, { operator: 'console-session-1' }), false, '★ 过期后再批准 = false');
  } finally {
    broker.close();
  }
});

test('IPC-23 迟到审批已被堵住：server 超时撤回票据后 decide 返回 false、审计 0 行、仍然不可能发送', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qzone-approval-ipc-late-'));
  const store = openOfflineStore(join(dir, 'state.db'), { audit: [] });
  const cleanupDir = () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { rmSync(dir, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  };
  t.after(() => { try { store.close(); } catch {} cleanupDir(); });
  assert.equal(initializeReplayState(store, { now: NOW }).ok, true);

  // The REAL recorder ("createQzoneApprovalAuditRecorder") against an in-memory sink, so the
  // consequence being measured is the row that would really be written — not a hand-made stub.
  const auditRows = [];
  const auditSink = {
    recordWrite(frame, stage, decision, outcome) {
      auditRows.push({ stage, decision: decision?.decision ?? null, outcome: outcome ?? null });
    },
  };
  const recorder = createQzoneApprovalAuditRecorder({ audit: auditSink, clock: () => NOW });
  const decisions = [];
  const broker = createQzoneOperationApprovalBroker({
    clock: () => NOW,
    recordDecision: (decision) => {
      decisions.push({ approved: decision.approved, id: decision.operation.authorizationId });
      return recorder(decision);
    },
  });
  t.after(() => broker.close());
  // A SHORT listener budget: the ask times out while the broker ticket is still 30s from its own
  // 'expiresAt', which is exactly the window this test is about.
  const listener = await createQzoneApprovalIpcServer({ broker, token: TOKEN, clock: () => NOW, timeoutMs: 150 });
  t.after(() => listener.close());
  const client = createQzoneApprovalIpcClient({
    origin: 'http://127.0.0.1:' + listener.port, token: TOKEN, clock: () => NOW, timeoutMs: 5_000,
  });
  t.after(() => client.close());

  const ledger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: 'r1', origin: 'qq-inbound' });
  ledger.observeStep({ sessionId: 's1', turn: 1, step: 1, messages: [{ role: 'user', source: { rpcId: 'r1' } }] });
  ledger.observeToolCall({ sessionId: 's1', event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1' } } });
  const consumption = ledger.consume({ sessionId: 's1', turn: 1, step: 1, callId: 'c1' });
  // Capture the exact operation the authorizer puts on the wire, so the late approval below asks
  // about THAT id instead of a fixture id.
  let wireOperation = null;
  const authorizer = createQzoneOperationAuthorizer({
    store, accountId: 123, sourceEpoch: 'e1', clock: () => NOW,
    approveOperation: (operation) => { wireOperation = operation; return client.approveOperation(operation); },
    isCurrent: () => true,
  });

  const expected = { action: 'publish', input: { content: 'hello qzone', ugc_right: 1 }, consumption, connectionEpoch: 0 };
  const ticket = await authorizer.prepare({
    action: 'publish', input: { content: 'hello qzone', ugc_right: 1 }, consumption, connectionEpoch: 0,
  });

  // (1) The plugin side gave up: no ticket was minted, so nothing can be claimed or sent.
  assert.equal(ticket, null, '★ 通道超时 ⇒ authorizer 不铸票');
  assert.equal(authorizer.claim({}, expected).ok, false, '★ 没有票据时 claim 拒绝（伪造对象也无效）');
  assert.equal(authorizer.verify({}, expected), false, '★ 没有票据时 verify 拒绝');

  // (2) The listener WITHDREW the ticket when its budget ran out: the operator's console no longer
  // offers a button for an ask nobody is waiting on.
  assert.deepEqual(broker.listPending(), [], '★★ 超时后票据必须已被撤回，控制台里没有可点的待审批项');

  // (3) The late approval is now REFUSED, and — the part that matters for the audit trail — it
  // leaves no row at all. Nothing is recorded, and in particular nothing is recorded as "rejected":
  // an abandoned ask has no decision, which is exactly what the audit shows.
  assert.notEqual(wireOperation, null, '前提：确实有一次询问跨过了通道');
  const lateVerdict = broker.decide({
    authorizationId: wireOperation.authorizationId, inputDigest: wireOperation.inputDigest, approved: true,
  }, { operator: 'console-session-1' });
  assert.equal(lateVerdict, false, '★★★ 撤回后迟到 decide 必须返回 false，不能事后批准');
  assert.deepEqual(decisions, [], '★★ recordDecision 一次都没被调用');
  assert.deepEqual(auditRows, [], '★★★ 审计里没有任何 approval 行：撤回不铺一条假的 rejected，也不留 approved');

  // (4) AND the send-side safety property, unchanged: the plugin never got a ticket, so there is
  // nothing to verify or claim and the write path cannot dispatch — before or after the attempt.
  const late = await authorizer.prepare({
    action: 'publish', input: { content: 'hello qzone', ugc_right: 1 }, consumption, connectionEpoch: 0,
  });
  assert.equal(late, null, '★ 迟到批准之后也不会补发票据：authorizer 不会重试');
  assert.equal(authorizer.claim({}, expected).ok, false, '★ 仍然没有任何可 claim 的票据');
});

test('IPC-25 生产默认配比（监听预算 = 票据 TTL）下，票据先于监听器超时关闭 ⇒ 迟到审批根本不存在', async (t) => {
  // The authorizer waits 30s ('APPROVAL_TIMEOUT_MS'), the broker's ticket lives 30s
  // ('OPERATION_TTL_MS'), and this listener's default budget is 30s. All three clocks start at
  // slightly different moments: the ticket's timer starts when the broker ENQUEUES (after the
  // request arrives) and the listener's timer starts after the BODY is read, i.e. strictly later.
  // So with matched budgets the ticket always dies first. This test compresses 30s to 300ms and
  // measures that ordering with the real broker and a real clock.
  const realNow = () => Date.now();
  const broker = createQzoneOperationApprovalBroker({ clock: realNow });
  t.after(() => broker.close());
  const listener = await createQzoneApprovalIpcServer({
    broker, token: TOKEN, clock: realNow, timeoutMs: 300,
  });
  t.after(() => listener.close());
  const client = createQzoneApprovalIpcClient({
    origin: 'http://127.0.0.1:' + listener.port, token: TOKEN, clock: realNow, timeoutMs: 5_000,
  });
  t.after(() => client.close());

  const operation = makeOperation({ expiresAt: realNow() + 300 });
  const started = Date.now();
  assert.equal(await client.approveOperation(operation), false, '★ 插件侧放弃');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 250, '确实等到了票据 TTL（' + elapsed + 'ms）');
  assert.ok(elapsed < 2_000, '不是客户端 5s 预算（' + elapsed + 'ms）');

  // By the time the plugin gave up, the broker had already closed the ticket by itself.
  assert.deepEqual(broker.listPending(), [], '★ 票据已自行过期，控制台里没有可点批准的东西');
  assert.equal(broker.decide({
    authorizationId: operation.authorizationId, inputDigest: operation.inputDigest, approved: true,
  }, { operator: 'console-session-1' }), false, '★ 生产配比下迟到审批返回 false，不存在"批准了却没发送"的行');
});

// ---------------------------------------------------------------------------------------------
// THE 2 MiB CAP, AGAINST THE FULL CONTRACT (not just one 100000-character field)
// ---------------------------------------------------------------------------------------------

test('IPC-24 契约允许的最大正文组合 + 最坏编码：reply（content+reply_name 各 100000）与 publish（+1000 收件人）都被接受', async (t) => {
  // Field bounds come from the contract itself, not from a guess:
  //   'text' = minLength 1, maxLength 100000   ('qzone-mcp-contract.mjs:9')
  //   reply  = tid, target_uin, content, comment_id, comment_uin, reply_uin, reply_name
  //            ('qzone-onebot-write-contract.mjs:7') -> content AND reply_name co-occur, both 'text'
  //   publish= content, ugc_right, target_uins (1..1000 recipients, 'qzone-onebot-write-contract.mjs:85')
  // Worst per-character wire cost is JSON's 6 bytes for a control character ('\u0000'), which beats
  // the 4 bytes of a supplementary-plane code point: the escape, not the code point, is the maximum.
  const MAX_TEXT = 100_000;
  const WORST_CHAR = '\u0000';
  const worst = WORST_CHAR.repeat(MAX_TEXT);
  const MAX_UIN = String(Number.MAX_SAFE_INTEGER);

  // --- reply: TWO maximum-length text fields in the same operation ---------------------------
  const replyInput = Object.freeze({
    tid: 'T'.repeat(128),
    target_uin: MAX_UIN,
    content: worst,
    comment_id: 'C'.repeat(128),
    comment_uin: MAX_UIN,
    reply_uin: MAX_UIN,
    reply_name: worst,
  });
  assert.equal(validateQzoneMcpInput('reply', replyInput), true, '前提：这确实是契约允许的输入');
  const replyOperation = makeOperation({
    action: 'reply',
    input: replyInput,
    sessionId: 's'.repeat(128),
    requestId: 'r'.repeat(128),
    callId: 'c'.repeat(128),
    sourceEpoch: 'e'.repeat(128),
    origin: 'o'.repeat(64),
    authorizationId: 'a'.repeat(128),
    accountId: Number.MAX_SAFE_INTEGER,
  });
  const replyFrame = serializeQzoneApprovalRequestFrame(replyOperation);
  assert.notEqual(replyFrame, null, '★ 契约最大 reply 帧可以序列化（没有被上限拒掉）');
  const replyBytes = Buffer.byteLength(replyFrame, 'utf8');
  assert.ok(replyBytes < QZONE_APPROVAL_IPC_MAX_FRAME_BYTES,
    '★ 最大 reply 帧 ' + replyBytes + ' B < 上限 ' + QZONE_APPROVAL_IPC_MAX_FRAME_BYTES + ' B');
  // Two full-length fields dominate: exact expectation is 2 * 100000 * 6 plus the fixed fields.
  assert.ok(replyBytes >= 2 * MAX_TEXT * 6, '确实是两个满长字段（' + replyBytes + ' B）');

  // The OTHER encoding the captain asked about: a supplementary-plane code point is 4 bytes in
  // UTF-8 and 2 UTF-16 units, so 100000 CHARACTERS of it is only ~200 000 bytes on the wire —
  // strictly cheaper than the control-character escape. Measured, not assumed, so the cap is not
  // accidentally tuned to one encoding.
  const supplementary = '😀'.repeat(MAX_TEXT); // 100000 code points, but 200000 UTF-16 units
  assert.equal(supplementary.length, MAX_TEXT * 2, '前提：补充平面字符是 2 个 UTF-16 单元');
  // 200000 UTF-16 units is over the contract's 100000-"character" cap (the cap counts UTF-16 units,
  // 'qzone-onebot-write-contract.mjs:41' uses 'value.length'), so the LEGAL maximum for this
  // encoding is 50000 code points = 100000 units — still 4 bytes per code point on the wire.
  const emojiLegal = Object.freeze({
    tid: 'T'.repeat(128), target_uin: MAX_UIN, content: '😀'.repeat(MAX_TEXT / 2),
    comment_id: 'C'.repeat(128), comment_uin: MAX_UIN,
  });
  assert.equal(emojiLegal.content.length, MAX_TEXT, '前提：100000 个 UTF-16 单元 = 契约上限');
  assert.equal(validateQzoneMcpInput('reply', emojiLegal), true, '前提：4 字节 UTF-8 正文合法');
  const emojiFrame = serializeQzoneApprovalRequestFrame(makeOperation({ action: 'reply', input: emojiLegal }));
  assert.notEqual(emojiFrame, null, '★ 4 字节 UTF-8 正文同样可以序列化');
  const emojiBytes = Buffer.byteLength(emojiFrame, 'utf8');
  assert.ok(emojiBytes < replyBytes, '4 字节补充平面编码比控制字符转义更省空间（'
    + emojiBytes + ' B < ' + replyBytes + ' B），所以 6 字节/字符才是上界');
  t.diagnostic('4-byte UTF-8 body frame: ' + emojiBytes + ' B (same 100000-unit content length)');

  // --- publish: one maximum-length text field PLUS the maximum recipient list ----------------
  const publishInput = Object.freeze({
    content: worst,
    ugc_right: 128,
    target_uins: Object.freeze(Array.from({ length: 1000 }, () => MAX_UIN)),
  });
  assert.equal(validateQzoneMcpInput('publish', publishInput), true, '前提：1000 个收件人是契约上限');
  const publishOperation = makeOperation({ action: 'publish', input: publishInput });
  const publishFrame = serializeQzoneApprovalRequestFrame(publishOperation);
  assert.notEqual(publishFrame, null, '★ 契约最大 publish 帧可以序列化');
  const publishBytes = Buffer.byteLength(publishFrame, 'utf8');
  assert.ok(publishBytes < QZONE_APPROVAL_IPC_MAX_FRAME_BYTES,
    '★ 最大 publish 帧 ' + publishBytes + ' B < 上限 ' + QZONE_APPROVAL_IPC_MAX_FRAME_BYTES + ' B');

  // --- and both must survive the REAL round trip, not just the serializer -------------------
  const received = [];
  const broker = fakeBroker((operation) => { received.push(operation); return true; });
  const { origin, client } = await boot(t, { broker, clientTimeoutMs: 20_000, serverTimeoutMs: 20_000 });

  assert.equal(await client.approveOperation(replyOperation), true, '★ 最大 reply 真的走通通道被批准');
  assert.equal(received[0].action, 'reply');
  assert.equal(received[0].input.content.length, MAX_TEXT, '正文长度在服务端完好');
  assert.equal(received[0].input.reply_name.length, MAX_TEXT, 'reply_name 长度在服务端完好');
  assert.equal(received[0].input.content.charCodeAt(0), 0, '最坏编码的字符原样到达（没有被转义破坏）');
  assert.equal(received[0].authorizationId, 'a'.repeat(128));
  assert.equal(received[0].accountId, Number.MAX_SAFE_INTEGER);

  assert.equal(await client.approveOperation(publishOperation), true, '★ 最大 publish 真的走通通道被批准');
  assert.equal(received[1].input.target_uins.length, 1000, '1000 个收件人一个不少');
  assert.equal(received[1].input.target_uins[999], MAX_UIN);
  assert.equal(received[1].input.content.length, MAX_TEXT);

  // The headroom is the point: 2 MiB is not a number that happens to work, it is above the
  // measured contract maximum by a wide margin (printed for the record).
  assert.ok(QZONE_APPROVAL_IPC_MAX_FRAME_BYTES > replyBytes * 1.5,
    '上限对实测最坏帧有 >50% 余量：' + QZONE_APPROVAL_IPC_MAX_FRAME_BYTES + ' vs ' + replyBytes);
  t.diagnostic('measured worst frames: reply=' + replyBytes + ' B, publish=' + publishBytes + ' B, cap='
    + QZONE_APPROVAL_IPC_MAX_FRAME_BYTES + ' B');
});

// ---------------------------------------------------------------------------------------------
// Constructor guards, and the cleanup the rest of the file depends on
// ---------------------------------------------------------------------------------------------

test('IPC-16 构造期护栏：非回环 origin / 空令牌 / 非回环监听地址都被拒', async (t) => {
  assert.throws(() => createQzoneApprovalIpcClient({ origin: 'http://example.com:80', token: TOKEN }),
    TypeError, '★ 客户端只接受回环 origin');
  assert.throws(() => createQzoneApprovalIpcClient({ origin: 'http://127.0.0.1:1234/path', token: TOKEN }),
    TypeError);
  assert.throws(() => createQzoneApprovalIpcClient({ origin: 'http://127.0.0.1:1234', token: 'short' }),
    TypeError, '★ 令牌长度必须够');
  await assert.rejects(
    () => createQzoneApprovalIpcServer({ broker: fakeBroker(), token: TOKEN, host: '0.0.0.0' }),
    TypeError, '★ 服务端不许监听非回环地址');
  await assert.rejects(
    () => createQzoneApprovalIpcServer({ broker: fakeBroker(), token: '' }),
    TypeError);
  await assert.rejects(
    () => createQzoneApprovalIpcServer({ broker: {}, token: TOKEN }),
    TypeError, '★ 必须给一个带 approveOperation 的 broker');
});

test('IPC-17 收尾：所有 listener 关闭后端口真的释放（用同一端口重新 listen）', async (t) => {
  const broker = fakeBroker(true);
  const server = await createQzoneApprovalIpcServer({
    broker, token: TOKEN, clock: () => NOW, timeoutMs: 1_000,
  });
  const port = server.port;
  const client = createQzoneApprovalIpcClient({
    origin: 'http://127.0.0.1:' + port, token: TOKEN, clock: () => NOW, timeoutMs: 1_000,
  });
  assert.equal(await client.approveOperation(makeOperation()), true);
  await client.close();
  await server.close();
  // The port must be bindable again right away; a lingering keep-alive socket would fail this.
  const again = await createQzoneApprovalIpcServer({
    broker, token: TOKEN, clock: () => NOW, timeoutMs: 1_000, port,
  });
  t.after(() => again.close());
  assert.equal(again.port, port, '★ 端口已释放并可原样重绑');
  // Auth is checked before routing, so an unauthenticated GET is 401 — the listener is answering.
  const probe = await fetch('http://127.0.0.1:' + port + QZONE_APPROVAL_IPC_PATH, { method: 'GET' });
  await probe.body?.cancel?.();
  assert.equal(probe.status, 401, '★ 重绑后的端口确实在接受连接');
});
