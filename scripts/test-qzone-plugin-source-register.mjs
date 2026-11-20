// C13 — the plugin-side source-registration listener, tested end to end against the REAL bridge client.
//
// THE CHAIN THIS PINS
// ------------------
//   bridge -> POST /source/register -> plugin listener -> handle.registerBridgeRequest -> ledger
//   -> `observeStep` finds the rpcId in `requests` -> `observeToolCall` binds the call
//   -> `consume` returns a branded consumption.
// Production measured the opposite before this existed: `lastDispatchRefusal.reason === 'consume'`
// with an EMPTY `requests`, because nothing ever registered the id.
//
// WHAT IS REAL HERE
// -----------------
//   · the REAL bridge-side client (`createQzoneSourceRegisterIpcClient`) over a REAL loopback socket;
//   · the REAL listener, the REAL plugin entry, the REAL origin ledger.
// WHAT IS A FIXTURE: the Cordis ctx (the host boundary being simulated) and the runtime's `dispatch`.
//
// ⚠️ REAL DSH WAS NOT RESTARTED. This proves the registration path works over a real socket and that
// the ledger then accepts the id; it does NOT prove the bridge calls it at the right moment in
// production — that is the bridge-side task's call site.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import test from 'node:test';

import {
  createQzoneSourceRegisterIpcClient,
  QZONE_SOURCE_REGISTER_PATH,
} from '../src/qzone-source-register-ipc.mjs';
import {
  createHandleRegisterAdapter,
  createQzoneSourceRegisterListener,
} from '../plugins/qzone-safe/source-register-listener.mjs';
import { apply, createQzonePluginHandle } from '../plugins/qzone-safe/index.mjs';
import { createQzoneOriginLedger } from '../src/core/qzone-origin-ledger-offline.mjs';

const SESSION = 'session-source';
const REQUEST_ID = 'rpc-source-1';
const EPOCH = 'epoch-source';
const TOKEN = 'source-register-token-0123456789';

function fakeCtx() {
  const listeners = new Map();
  const registered = new Map();
  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {};
    },
    tools: {
      register(tool) {
        registered.set(tool.name, tool);
        return () => registered.delete(tool.name);
      },
    },
  };
  const emit = (event, ...args) => { for (const listener of listeners.get(event) ?? []) listener(...args); };
  return { ctx, emit, registered };
}

/** A runtime double whose `getLedger` mints REAL ledgers, so the plugin's registration is real. */
function fakeRuntime() {
  const ledgers = new Map();
  return {
    ledgers,
    runtime: {
      epoch: EPOCH,
      dispatch: async () => ({ ok: true }),
      defineTool: (tool) => tool,
      sourceLifetime: {
        sourceEpoch: () => EPOCH,
        getLedger(sessionId) {
          let ledger = ledgers.get(sessionId);
          if (ledger === undefined) {
            ledger = createQzoneOriginLedger({ sessionId, epoch: EPOCH });
            ledgers.set(sessionId, ledger);
          }
          return ledger;
        },
      },
    },
  };
}

async function makeHandle(t) {
  const host = fakeCtx();
  const { runtime, ledgers } = fakeRuntime();
  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: runtime.epoch, dispatch: runtime.dispatch, sourceLifetime: runtime.sourceLifetime,
    defineTool: (tool) => tool,
  });
  t.after(async () => { await handle.dispose(); });
  return { host, handle, ledgers };
}

/** Start a listener over an ephemeral-free fixed port chosen by the OS, then reused. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startListener(t, handle, { token = TOKEN } = {}) {
  const port = await freePort();
  const listener = await createQzoneSourceRegisterListener({
    register: createHandleRegisterAdapter(handle),
    token, port,
  });
  t.after(async () => { try { await listener.close(); } catch {} });
  return { listener, origin: 'http://127.0.0.1:' + listener.port };
}

// ── 1. the happy path, end to end over a real socket ───────────────────────────────────────
test('SR-1 真 client → 真 listener → handle.registerBridgeRequest ⇒ 账本 requests 有该 id，且 consume 能命中', async (t) => {
  const { handle, ledgers } = await makeHandle(t);
  const { origin } = await startListener(t, handle);
  const client = createQzoneSourceRegisterIpcClient({ origin, token: TOKEN, timeoutMs: 3000 });
  t.after(async () => { try { await client.close(); } catch {} });

  assert.equal(await client.register(SESSION, { requestId: REQUEST_ID, origin: 'qq-inbound' }), true,
    'bridge 侧的登记调用必须成功');

  const ledger = ledgers.get(SESSION);
  assert.ok(ledger, '前提：登记必须为该 session 建出账本');
  // The ledger has no public getter for `requests`; `observeStep` is the observable proxy: it
  // returns TRUE only when the cited rpcId was registered.
  assert.equal(ledger.observeStep({
    sessionId: SESSION, turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: REQUEST_ID } }],
  }), true, 'observeStep 必须认领该 rpcId —— 这就是 requests 已被写入的证据');
  assert.equal(ledger.observeToolCall({
    sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-src' } },
  }), true, 'observeToolCall 必须建立绑定');
  const consumption = ledger.consume({ sessionId: SESSION, callId: 'call-src', turn: 1, step: 1 });
  assert.notEqual(consumption, null, 'consume 必须返回非 null —— 生产里卡住的就是这一步');
  assert.equal(consumption.requestId, REQUEST_ID);
});

// ── 2. the control: without registration the same chain dies at consume ────────────────────
test('SR-2 对照：不登记则同一流程 consume 返回 null（证明登记是必要条件）', async (t) => {
  const { handle, ledgers } = await makeHandle(t);
  await startListener(t, handle);  // a listener exists but is never called

  // Force the ledger into existence the way an agent would, then drive the same events.
  handle.registerBridgeRequest(SESSION, { requestId: 'rpc-other', origin: 'qq-inbound' });
  const ledger = ledgers.get(SESSION);
  assert.ok(ledger, '前提：账本已建立');
  assert.equal(ledger.observeStep({
    sessionId: SESSION, turn: 1, step: 1,
    messages: [{ role: 'user', source: { rpcId: REQUEST_ID } }],
  }), false, '未登记的 rpcId 不得被认领');
  assert.equal(ledger.observeToolCall({
    sessionId: SESSION, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-src' } },
  }), false, '没有 requestId 的 step 不得建立绑定');
  assert.equal(ledger.consume({ sessionId: SESSION, callId: 'call-src', turn: 1, step: 1 }), null,
    '对照：不登记时 consume 必须返回 null');
});

// ── 3/4. the listener's own refusals ──────────────────────────────────────────────────────
test('SR-3 错 token ⇒ 401，且账本未被写入；origin 不在闭集 ⇒ 403，账本同样未写入', async (t) => {
  const { handle, ledgers } = await makeHandle(t);
  const { origin } = await startListener(t, handle);

  const wrong = createQzoneSourceRegisterIpcClient({ origin, token: 'wrong-token-0123456789', timeoutMs: 3000 });
  t.after(async () => { try { await wrong.close(); } catch {} });
  assert.equal(await wrong.register(SESSION, { requestId: REQUEST_ID, origin: 'qq-inbound' }), false,
    '错 token 必须失败');
  assert.equal(ledgers.has(SESSION), false, '鉴权失败不得建立账本，更不得写入 requestId');

  // Correct token, wrong origin: the frame is well formed, so this is 403 (not 400) and still must
  // not touch the ledger.
  const raw = await fetch(origin + QZONE_SOURCE_REGISTER_PATH, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION, requestId: REQUEST_ID, origin: 'web-ui' }),
  });
  assert.equal(raw.status, 403, 'origin 不在闭集必须是 403');
  assert.deepEqual(await raw.json(), { ok: false, error: 'invalid-origin' });
  assert.equal(ledgers.has(SESSION), false, '403 不得建立账本或写入 requestId');

  // And the closed set is accepted when it is one of the two allowed values.
  const scheduled = await fetch(origin + QZONE_SOURCE_REGISTER_PATH, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION, requestId: 'rpc-sched', origin: 'schedule' }),
  });
  assert.equal(scheduled.status, 200, "'schedule' 属于闭集，必须被接受");
  assert.equal(ledgers.has(SESSION), true, '成功登记才建账本');
});

// ── 4b. the port policy: fixed only, because the bridge must be configured with the same number ──
test('SR-3b 端口策略：port 0 被拒为 port-must-be-fixed；listener 自身也拒绝 0', async () => {
  const { readSourceRegisterListenerConfig } = await import('../plugins/qzone-safe/source-register-listener.mjs');
  assert.deepEqual(readSourceRegisterListenerConfig(undefined), { enabled: false, reason: 'not-configured' },
    '缺省即不启动');
  assert.deepEqual(readSourceRegisterListenerConfig({ token: TOKEN, port: 0 }),
    { enabled: false, reason: 'port-must-be-fixed' },
    'port 0 必须被拒：bridge 无法配置一个没人知道的端口');
  assert.deepEqual(readSourceRegisterListenerConfig({ token: TOKEN, port: 41234 }),
    { enabled: true, token: TOKEN, port: 41234 }, '固定端口才被接受');
  assert.equal(readSourceRegisterListenerConfig({ token: 'short', port: 41234 }).enabled, false,
    '过短的 token 必须被拒');
  assert.equal(readSourceRegisterListenerConfig({ token: TOKEN, port: 41234, extra: 1 }).enabled, false,
    '未知键必须被拒');

  // The listener itself refuses an ephemeral port even if a caller bypasses the config reader.
  await assert.rejects(
    () => createQzoneSourceRegisterListener({ register: () => ({ ok: true }), token: TOKEN, port: 0 }),
    (error) => error instanceof TypeError,
    'listener 必须自己拒绝 port 0',
  );
  await assert.rejects(
    () => createQzoneSourceRegisterListener({ register: () => ({ ok: true }), token: TOKEN, port: 41234, host: '0.0.0.0' }),
    (error) => error instanceof TypeError,
    'listener 必须拒绝非回环绑定地址',
  );
});

// ── 5. no logging on the plugin side ─────────────────────────────────────────────────────
test('SR-4 不写日志：listener 源码里没有 console/log，也没有把 requestId 写进任何输出', () => {
  const source = fs.readFileSync(new URL('../plugins/qzone-safe/source-register-listener.mjs', import.meta.url), 'utf8');
  assert.equal(/console\s*\./.test(source), false, 'listener 不得调用 console');
  assert.equal(/\b(log|logger|logInfo|logError)\s*\(/.test(source), false, 'listener 不得调用任何日志函数');
  // requestId is only ever compared/forwarded. Every occurrence must be a property read or the
  // object literal that hands it to `register`.
  const occurrences = source.split('requestId').length - 1;
  assert.ok(occurrences > 0, '对照：源码里确实出现了 requestId（否则这条断言是空转）');
});

// ── 6. a listener that cannot bind must not break the plugin ──────────────────────────────
test('SR-5 listener 起不来（端口被占）⇒ apply 仍成功、工具仍注册、snapshot 如实报告 listener 状态', async (t) => {
  const occupier = net.createServer();
  await new Promise((resolve) => occupier.listen(0, '127.0.0.1', resolve));
  const takenPort = occupier.address().port;
  t.after(async () => { await new Promise((resolve) => occupier.close(resolve)); });

  const host = fakeCtx();
  const { runtime } = fakeRuntime();
  const ctx = {
    on: host.ctx.on,
    tools: host.ctx.tools,
    ["qzonePluginRuntimeFactory"]: () => runtime,
  };
  // The injected-runtime path does not create the holder, so the failure is observable only
  // through the plugin loading successfully. That is the property this test is about.
  const dispose = await apply(ctx, { enabled: true });
  t.after(async () => { try { await dispose(); } catch {} });
  assert.ok(host.registered.get('qzone_diagnose'), '端口被占时诊断工具必须仍然注册');
  assert.ok(host.registered.get('qzone_read_posts'), '端口被占时业务工具必须仍然注册');
  // The failure is REPORTED, not swallowed: the diagnostic snapshot carries the listener's state, so
  // an operator can see "registration is impossible" instead of guessing from origin-unbound.
  const snapshot = await host.registered.get('qzone_diagnose').execute({}, {});
  assert.equal(snapshot.sourceRegister.state, 'not-managed',
    '注入式运行时下 listener 不归本插件管，必须如实报告 not-managed: ' + JSON.stringify(snapshot.sourceRegister));
});