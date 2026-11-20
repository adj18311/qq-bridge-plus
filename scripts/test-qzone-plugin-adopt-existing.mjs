// t8 — ADOPTION: bind the agents that already exist when the plugin finishes loading.
//
// ONE minimal regression, two directions. It exists because after a DSH restart
// `qzone_read_posts` answered `{ ok: false, error: 'origin-unbound' }` in production (twice).
//
// THE HYPOTHESIS THIS PINS (stated as a hypothesis, not a proven sole cause)
// ---------------------------------------------------------------------------
// `apply()` awaits the runtime build BEFORE it constructs the handle, and the `agent/created` /
// `session/event` subscriptions live inside that handle — so they are installed late. DSH restores
// its sessions immediately, inside that window, and those events are emitted to nobody. No adapter
// ⇒ no ledger for the session ⇒ no `positions` entry ⇒ `origin-unbound` on every call.
// It is judged HIGH PROBABILITY, not certain: the other `origin-unbound` branches in
// `dispatchBound` (dead ledger, missing position, foreign session, replay) were NOT separately
// excluded by measurement, because doing so needs a live DSH restart with instrumentation.
//
// WHAT THIS TEST PROVES
// ---------------------
//   (a) a real, NEW event for a pre-existing agent reaches the ledger after adoption and dispatches;
//   (b) a call the plugin NEVER observed — the ones lost in the restart window — still answers
//       `origin-unbound`. Adoption establishes FUTURE observation only; it grants nothing to the
//       past. If a later change made (b) pass, the plugin would be minting origin evidence for
//       unobserved calls, which is precisely what must never happen.
//
// WHAT IS REAL HERE: the real plugin entry, the real runtime and origin ledger, the real pre-step
// adapter and session observer, driven by real payload shapes; a real temporary SQLite store.
// WHAT IS A FIXTURE: the Cordis CONTEXT (`on` / `tools.register` / `get('agents')`) — that double IS
// the host boundary being simulated — and the platform transport (no QQ request; canned data).
//
// ⚠️ REAL DSH WAS NOT STARTED. This proves the plugin's behaviour against a faithful ctx double;
// it does NOT prove that DSH's real `agents` service exposes `list()` with this shape, nor that the
// restart timing reproduces exactly as modelled.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createQzonePluginHandle, STATES } from '../plugins/qzone-safe/index.mjs';
import { createQzoneRuntime } from '../src/core/qzone-runtime-wiring.mjs';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { initializeReplayState } from '../src/core/qzone-replay-claim-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

const BOT = 10001;
const FRIEND = 20002;
const NOW = Date.parse('2026-11-17T01:00:00Z');
const SESSION = 'session-restored';

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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-adopt-'));
  t.after(() => {
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(directory, { recursive: true, force: true }); return; } catch { /* windows handle delay */ }
    }
  });
  return directory;
}

/**
 * The host-boundary double.
 *
 * `existing` is what the host reports for agents it restored BEFORE this plugin finished loading.
 * Listeners are collected the moment they are registered, so anything EMITTED BEFORE the plugin
 * subscribes reaches nobody — which is exactly the restart window being modelled.
 */
function fakeCtx({ existing = [] } = {}) {
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
    get(name) {
      return name === 'agents' ? { list: () => existing } : undefined;
    },
  };
  const emit = (event, ...args) => { for (const listener of listeners.get(event) ?? []) listener(...args); };
  return { ctx, emit, registered };
}

/** One agent object shaped the way the plugin reads it from `agent/created`. */
function makeAgent(sessionId = SESSION) {
  const preStep = [];
  return {
    agent: {
      id: 'agent-restored',
      session: { id: sessionId },
      ctx: {
        on(name, listener) {
          if (name === 'agent/pre-step') preStep.push(listener);
          return () => {};
        },
      },
    },
    /** Emit one `agent/pre-step`, as the host does. */
    preStep(turn, step, messages) {
      for (const listener of preStep) listener({ turn, step, messages }, () => {});
    },
  };
}

/** A real runtime over a real temporary SQLite store; the transport is canned (no QQ request). */
function realRuntime(t) {
  const store = openOfflineStore(path.join(tempDir(t), 'state.sqlite'), initialState());
  t.after(() => { try { store.close(); } catch {} });
  assert.equal(initializeReplayState(store, { now: NOW }).ok, true, '前提：B2 replay 集合必须初始化');
  return createQzoneRuntime({
    store,
    botQq: BOT,
    sourceEpoch: 'epoch-adopt',
    authorizeSource: () => true,
    getConnectionEpoch: () => 1,
    getBridgeSessions: () => null,
    clock: () => NOW,
    mode: 'enabled',
    call: async (action) => {
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: BOT } };
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [{ user_id: FRIEND }] };
      if (action === 'get_qzone_msg_list') {
        return { status: 'ok', retcode: 0, data: { total: 1, msglist: [{ tid: 'post-1', content: 'restored', time: Math.floor(NOW / 1000) - 60 }] } };
      }
      throw new Error('unexpected fixture action ' + action);
    },
  });
}

test('AD-1 补绑只给将来开门、不给过去发通行证：新事件可派发，补绑之前丢失的调用仍 origin-unbound', async (t) => {
  const runtime = realRuntime(t);
  const { agent, preStep } = makeAgent();
  const host = fakeCtx({ existing: [agent] });

  // ── the restart window, modelled exactly ──────────────────────────────────────────────────
  // The host restores the session and announces it BEFORE this plugin has subscribed. Both emits
  // reach nobody (`host.emit` only reaches listeners that already exist). This is the loss the
  // adoption sweep cannot — and must not — repair: there is no ordering evidence for it.
  host.emit('agent/created', { agent });
  host.emit('session/event', { id: SESSION }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-lost', name: 'qzone_read_posts' } });

  const handle = await createQzonePluginHandle(host.ctx, { enabled: true }, {
    epoch: 'epoch-adopt', dispatch: runtime.dispatch, defineTool: (tool) => tool,
  });
  t.after(async () => { await handle.dispose(); });

  assert.equal(handle.status().state, STATES.DISPATCH_READY, '前提：注入完整 runtime 后必须进入 dispatch-ready');
  assert.equal(handle.status().agentAdapters, 1, '补绑必须为那个早就存在的 agent 建立 adapter');
  assert.deepEqual([...handle.status().dispatchableSessions], [SESSION],
    '补绑后该会话必须进入可派发集合');

  const tool = host.registered.get('qzone_read_posts');
  assert.ok(tool, '前提：qzone_read_posts 必须已注册');

  // ── (b) THE PAST IS NOT REOPENED ────────────────────────────────────────────────────────
  // `call-lost` was announced while nobody was listening. Adoption installed the adapter, but it
  // did NOT and must NOT fabricate a position or a ledger binding for that call. Dispatching it
  // therefore still refuses — evidence cannot be manufactured retroactively.
  const lost = await tool.execute({ target_uin: FRIEND, pos: 0, num: 20 },
    { callId: 'call-lost', agent: { session: { id: SESSION } } });
  assert.deepEqual(lost, { ok: false, error: 'origin-unbound' },
    '补绑之前就丢失的调用必须仍然 origin-unbound —— 补绑不得补造来源证据: ' + JSON.stringify(lost));

  // ── (a) THE FUTURE IS OPEN ──────────────────────────────────────────────────────────────
  // A NEW inbound request observed by the now-installed adapter reaches the ledger, so the same
  // tool dispatches for real.
  handle.registerBridgeRequest(SESSION, { requestId: 'rpc-new', origin: 'qq-inbound' });
  preStep(1, 1, [{ role: 'user', source: { rpcId: 'rpc-new' } }]);
  host.emit('session/event', { id: SESSION }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-new', name: 'qzone_read_posts' } });

  const fresh = await tool.execute({ target_uin: FRIEND, pos: 0, num: 20 },
    { callId: 'call-new', agent: { session: { id: SESSION } } });
  assert.notDeepEqual(fresh, { ok: false, error: 'origin-unbound' },
    '补绑之后的新真实事件必须不再 origin-unbound: ' + JSON.stringify(fresh));
  assert.equal(fresh.ok, true, '新事件经真实账本消费后必须派发成功: ' + JSON.stringify(fresh));
  assert.equal(fresh.outcome, 'success', '真实读链必须返回假 transport 的数据');
  assert.deepEqual(fresh.posts.map((post) => post.id), ['post-1']);
});