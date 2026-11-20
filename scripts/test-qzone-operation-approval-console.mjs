import assert from 'node:assert/strict';
import test from 'node:test';
import { createQzoneOperationApprovalBroker } from '../src/core/qzone-operation-approval-console.mjs';
import { createQzoneConsoleGateway } from '../src/core/qzone-console-gateway.mjs';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneOperationAuthorizer } from '../src/core/qzone-operation-authorization-offline.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';
import { createOfflineWritePath } from '../src/core/qzone-write-path-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const NOW = 1_800_000_000_000;
const operation = (id = 'auth-1') => Object.freeze({
  authorizationId: id, accountId: 123, sessionId: 's1', requestId: 'r1', callId: 'c1',
  action: 'publish', input: Object.freeze({ content: 'hello', ugc_right: 1 }),
  inputDigest: 'a'.repeat(64), expiresAt: NOW + 30000,
});

test('operator sees and approves the exact operation once', async () => {
  const broker = createQzoneOperationApprovalBroker({ clock: () => NOW });
  const waiting = broker.approveOperation(operation());
  const [pending] = broker.listPending();
  assert.deepEqual(pending.input, { content: 'hello', ugc_right: 1 });
  assert.equal(broker.decide({ authorizationId: pending.authorizationId, inputDigest: pending.inputDigest, approved: true }), true);
  assert.equal(await waiting, true);
  assert.equal(broker.decide({ authorizationId: pending.authorizationId, inputDigest: pending.inputDigest, approved: true }), false);
  assert.deepEqual(broker.listPending(), []);
});

test('wrong digest, denial, expiry and capacity fail closed', async () => {
  let now = NOW;
  const broker = createQzoneOperationApprovalBroker({ clock: () => now, capacity: 1 });
  const waiting = broker.approveOperation(operation());
  assert.equal(await broker.approveOperation(operation('auth-2')), false);
  assert.equal(broker.decide({ authorizationId: 'auth-1', inputDigest: 'b'.repeat(64), approved: true }), false);
  assert.equal(broker.decide({ authorizationId: 'auth-1', inputDigest: 'a'.repeat(64), approved: false }), true);
  assert.equal(await waiting, false);
  const expired = broker.approveOperation(operation('auth-3'));
  now += 30000;
  assert.equal(broker.decide({ authorizationId: 'auth-3', inputDigest: 'a'.repeat(64), approved: true }), false);
  assert.equal(await expired, false);
});

test('console approval requires the existing console, CSRF and QZone session checks', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qzone-approval-console-'));
  const store = openOfflineStore(join(dir, 'state.db'), { audit: [] });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const decisions = [];
  const broker = createQzoneOperationApprovalBroker({ clock: () => NOW,
    recordDecision: (event) => { decisions.push(event); return true; } });
  t.after(() => broker.close());
  const gateway = createQzoneConsoleGateway({ store, stateDir: dir, selfId: '123',
    consoleToken: 'fixture-console-token', authorizeConsole: (request) => request.headers.auth === 'ok',
    verifyCsrf: (request) => request.headers.csrf === 'ok', isAgentPaused: () => true,
    now: () => NOW, operationApprovals: broker });
  const request = (method, path, headers = {}, body) => ({ method,
    pathname: `/api/console/qqspace-column${path}`, headers, ...(body === undefined ? {} : { body }) });
  const auth = { auth: 'ok', csrf: 'ok' };
  const setup = await gateway(request('POST', '/auth/setup', auth, { password: 'example-password-one' }));
  assert.equal(setup.status, 200);
  const headers = { ...auth, cookie: setup.headers['set-cookie'].split(';')[0] };
  // ⚠️ 人工审批已随用户裁定退役（t55）：`/operation-approvals` 路由整枝删除。
  // 这条用例原来断言「未认证 401 / 无 CSRF 403 / 正常 200 / 伪造 operator 400」，
  // 现在全部应该是 404 —— 路由不存在，任何方法任何鉴权都一样。
  // 保留这条用例（而不是删掉它）是为了**记录这个接口已经不存在**：万一有人把路由加回来，
  // 这里会立刻变红，提醒他审批是需要用户重新裁决的产品决定，不是可以顺手恢复的代码。
  const waiting = broker.approveOperation(operation());
  // 鉴权/CSRF 守卫在路由分发**之前**执行（gateway 的第一件事），所以未认证仍然是 401、
  // 缺 CSRF 仍然是 403 —— 这是对的：不能让调用方从状态码上探出某个路由存不存在。
  // 只有通过了外层守卫的请求才会走到路由表，那时才拿到 404。
  for (const [label, method, hdrs, body, status] of [
    ['未认证 GET', 'GET', auth, undefined, 401],
    ['未认证 POST', 'POST', auth, { authorizationId: 'auth-1', inputDigest: 'a'.repeat(64), approved: true }, 401],
    ['缺 CSRF GET', 'GET', { ...headers, csrf: 'no' }, undefined, 403],
    ['完整认证 GET', 'GET', headers, undefined, 404],
    ['完整认证 POST', 'POST', headers, { authorizationId: 'auth-1', inputDigest: 'a'.repeat(64), approved: true }, 404],
  ]) {
    assert.equal((await gateway(request(method, '/operation-approvals', hdrs, body))).status, status,
      label + ' 期望 ' + status + '（守卫在前，认证通过后才暴露 404）');
  }
  // broker 仍可单独使用（runtime 侧注入 approveOperation），但控制台不再有入口。
  // ⚠️ 有 recordDecision 时 decide 必须带 operator：审批要留审计行，没有操作者就无法记账，
  // broker 会直接 finish(false)（这正是「不可记录的批准不得通过」那条规则的落地）。
  // 以前 operator 由网关从已验证的服务端会话里取；现在没有网关入口，测试自己给一个。
  const [firstPending] = broker.listPending();
  assert.equal(broker.decide({ authorizationId: firstPending.authorizationId,
    inputDigest: firstPending.inputDigest, approved: true }, { operator: 'operator-1' }), true);
  assert.equal(await waiting, true);
  assert.equal(decisions.length, 1);
  assert.equal(typeof decisions[0].operator, 'string');
  assert.equal(decisions[0].operation.authorizationId, 'auth-1');
});

test('an unrecordable decision cannot approve an operation', async () => {
  const broker = createQzoneOperationApprovalBroker({ clock: () => NOW, recordDecision: () => { throw new Error('store unavailable'); } });
  const waiting = broker.approveOperation(operation());
  assert.equal(broker.decide({ authorizationId: 'auth-1', inputDigest: 'a'.repeat(64), approved: true }, { operator: 'operator-1' }), false);
  assert.equal(await waiting, false);
});

test('the approval panel is GONE from the console page', async () => {
  // t55：用户裁定不要人工审批，`/operation-approvals` 路由与前端面板都已删除。
  // 这条用例从「面板能显示参数并提交决定」翻转成「面板必须不存在」——
  // 它守的是产品决定，不是一个实现细节。
  const html = readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  assert.equal(html.match(/let qzoneApprovalTimer = null;/)?.[0], undefined,
    '审批面板的渲染代码必须已被删除');
  assert.doesNotMatch(html, /qzoneApprovals/, '不得残留审批列表容器');
  assert.doesNotMatch(html, /qzoneApprovalWatch/, '不得残留审批订阅按钮');
  assert.doesNotMatch(html, /operation-approvals/, '前端不得再调用审批路由');
});

test('real branded operation authorizer waits for the console decision', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qzone-approval-chain-'));
  const store = openOfflineStore(join(dir, 'state.db'), { audit: [] });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const broker = createQzoneOperationApprovalBroker({ clock: () => NOW });
  t.after(() => broker.close());
  const ledger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: 'r1', origin: 'qq-inbound' });
  assert.equal(ledger.observeStep({ sessionId: 's1', turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'r1' } }] }), true);
  assert.equal(ledger.observeToolCall({ sessionId: 's1', event: { type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c1' } } }), true);
  const consumption = ledger.consume({ sessionId: 's1', turn: 1, step: 1, callId: 'c1' });
  const authorizer = createQzoneOperationAuthorizer({ store, accountId: 123, sourceEpoch: 'e1',
    clock: () => NOW, approveOperation: broker.approveOperation, isCurrent: () => true });
  const waiting = authorizer.prepare({ action: 'publish', input: { content: 'hello', ugc_right: 1 },
    consumption, connectionEpoch: 0 });
  const [pending] = broker.listPending();
  assert.equal(pending.action, 'publish');
  assert.equal(pending.input.ugc_right, 1);
  assert.equal(broker.decide({ authorizationId: pending.authorizationId, inputDigest: pending.inputDigest, approved: true }), true);
  assert.equal((await waiting).operation.authorizationId, pending.authorizationId);
});

test('an authenticated console approval releases exactly one guarded offline publish', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qzone-approval-runtime-'));
  const state = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 10, comment: 25, like: 30 }, ledger: { day: beijingDay(NOW),
      used: { post: 0, comment: 0, like: 0 }, reservations: {} }, lastPostAt: null,
    lastCommentAt: null, commentTargets: [], likes: [], audit: [], reads: 0, writes: 0,
    readAttempts: {}, readOutcomes: {}, browseDay: beijingDay(NOW), todayBrowses: 0,
    lastBrowseAt: null, usedOpportunities: {}, activeStart: 0, activeEnd: 1439, notices: [] };
  const store = openOfflineStore(join(dir, 'state.db'), state);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(initializeReplayState(store, { now: NOW }).ok, true);
  const decisions = [];
  const broker = createQzoneOperationApprovalBroker({ clock: () => NOW,
    recordDecision: (decision) => { decisions.push(decision); return true; } });
  t.after(() => broker.close());
  const gateway = createQzoneConsoleGateway({ store, stateDir: dir, selfId: '123',
    consoleToken: 'fixture-console-token', authorizeConsole: (request) => request.headers.auth === 'ok',
    verifyCsrf: (request) => request.headers.csrf === 'ok', isAgentPaused: () => true,
    now: () => NOW, operationApprovals: broker });
  const request = (method, path, headers, body) => ({ method,
    pathname: `/api/console/qqspace-column${path}`, headers, ...(body === undefined ? {} : { body }) });
  const auth = { auth: 'ok', csrf: 'ok' };
  const setup = await gateway(request('POST', '/auth/setup', auth, { password: 'example-password-one' }));
  assert.equal(setup.status, 200);
  const headers = { ...auth, cookie: setup.headers['set-cookie'].split(';')[0] };
  const ledger = createQzoneOriginLedger({ sessionId: 's1', epoch: 'e1' });
  ledger.registerBridgeRequest({ requestId: 'r1', origin: 'qq-inbound' });
  assert.equal(ledger.observeStep({ sessionId: 's1', turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: 'r1' } }] }), true);
  assert.equal(ledger.observeToolCall({ sessionId: 's1', event: { type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c1' } } }), true);
  const sent = [];
  const runtime = createQzoneRuntime({ store, botQq: 123, sourceEpoch: 'e1',
    getConnectionEpoch: () => 0, authorizeSource: (consumption) => ledger.ownsConsumption(consumption),
    getBridgeSessions: () => ledger, clock: () => NOW, mode: 'enabled', call: async () => { throw new Error('unexpected read'); },
    operationAuthorization: { replayStore: store, approveOperation: broker.approveOperation },
    writeWiring: { source: 'qq', actions: ['publish'],
      writePath: (transport) => createOfflineWritePath({ store, clock: () => NOW, transport }),
      send: async (payload) => { sent.push(payload); return { ok: true }; } } });
  const waiting = runtime.dispatch('publish', { content: 'hello', ugc_right: 1 }, { sessionId: 's1', callId: 'c1' });
  assert.equal(sent.length, 0);
  // t55：控制台不再提供审批入口，但 broker 本身仍是 runtime 注入的批准来源。
  // 直接从 broker 取 pending 并裁决 —— 这正是「无人工审批」下 approveOperation 的用法：
  // 宿主策略恒真（AUTO_APPROVE_POLICY），审批面板不存在。
  assert.equal((await gateway(request('GET', '/operation-approvals', headers))).status, 404,
    '审批路由必须已删除');
  const pendingOps = broker.listPending();
  assert.equal(pendingOps.length, 1);
  const pending = pendingOps[0];
  assert.equal(broker.decide({ authorizationId: pending.authorizationId,
    inputDigest: pending.inputDigest, approved: true }, { operator: 'operator-1' }), true);
  const result = await waiting;
  assert.equal(result.outcome, 'success');
  assert.equal(sent.length, 1);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].operator.length > 0, true);
  assert.equal(Object.keys(store.read().usedReadKeys).length, 1);
});
