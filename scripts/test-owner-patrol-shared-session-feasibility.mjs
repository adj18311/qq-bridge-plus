// 离线可行性探针，不是生产授权实现：真实 hook/controller，临时状态与回环 HTTP。
// 问题：仅共享 sessionId + 调用方自报 source，现有门禁能否区分 owner/patrol？
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBackgroundPatrolBridgeHook } from '../src/core/background-patrol-bridge-hook.mjs';
import { postJson } from './test-port-safe.mjs';

const owner = 123456789;
const session = 'offline-shared-session';
const token = 'offline-shared-probe-token-0123456789';
const now = Date.now();

async function withHook(alsoPatrol, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shared-session-feasibility-'));
  const sessions = { [`private:${owner}`]: session };
  // sessionsProvider 启用时真实 hook 只从实时映射读取后台会话，忽略初始参数作为后备。
  sessions['patrol:background'] = alsoPatrol ? session : 'separate-patrol';
  let hook;
  try {
    const storePath = path.join(dir, 'controller.json');
    await writeFile(storePath, JSON.stringify({
      schemaVersion: 1, day: '2026-10-27', lastSeenAt: now, readCount: 0,
      buckets: { post: { count: 0, lastActionAt: null }, comment: { count: 0, lastActionAt: null } },
      operations: {}, consecutiveWriteFailures: 0, writePaused: false, writeReason: null,
      accessPaused: false, accessReason: null, transitionEvents: [], transitionEventOverflow: 0,
    }), 'utf8');
    hook = createBackgroundPatrolBridgeHook({
      config: { backgroundPatrol: { enabled: true, platforms: { tieba: true, xiaoheihe: true }, groupExempt: true } },
      consoleToken: token, controllerStorePath: storePath, ownerQQ: owner, sessions,
      sessionsProvider: () => sessions, backgroundSessionId: alsoPatrol ? session : 'separate-patrol',
      port: 0, logger: { warn() {}, error() {} },
    });
    const started = await hook.start();
    assert.equal(started.ok, true);
    await hook.reconcile({ enqueue: async () => ({ ok: true, id: 'seen', duplicate: true }), isDelivered: async () => ({ ok: true, delivered: true }) });
    const call = async (tool, source, agentKey = session) => {
      const response = await postJson(`${started.url}/api/xiaoheihe/authorize`, {
        agentKey, tool, source, args: { operationId: `probe-${source}` },
      }, { 'x-console-token': token });
      return await response.json();
    };
    const commit = async (ticket, agentKey = session) => {
      const response = await postJson(`${started.url}/api/xiaoheihe/commit`, { ticket, agentKey }, { 'x-console-token': token });
      return await response.json();
    };
    const persistedState = async () => JSON.parse(await readFile(storePath, 'utf8'));
    await run(call, commit, persistedState);
  } finally {
    await hook?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('同一 owner session：自报 patrol 不会让真实凭据门禁区分两次调用', async () => {
  await withHook(false, async (call) => {
    const ordinary = await call('mcp__xiaoheihe__interactive_login', 'owner');
    const claimedPatrol = await call('mcp__xiaoheihe__interactive_login', 'patrol');
    assert.equal(ordinary.decision, 'allow');
    assert.equal(claimedPatrol.decision, 'allow', '不能误称现有系统已按 source 拒绝巡逻');
  });
});

test('同一 session 同时注册为巡逻：真实管理员凭据操作也被拒绝', async () => {
  await withHook(true, async (call) => {
    const ordinary = await call('mcp__xiaoheihe__interactive_login', 'owner');
    assert.equal(ordinary.decision, 'deny');
    assert.equal(ordinary.reason, 'unknown-agent');
  });
});

test('同一 owner session：自报来源不会改变真实写入授权分类', async () => {
  let ordinary;
  let claimedPatrol;
  await withHook(false, async (call) => { ordinary = await call('mcp__xiaoheihe__publish_content', 'owner'); });
  await withHook(false, async (call) => { claimedPatrol = await call('mcp__xiaoheihe__publish_content', 'patrol'); });
  assert.equal(ordinary.decision, 'allow');
  assert.equal(claimedPatrol.decision, 'allow');
  assert.equal(ordinary.ticket.kind, claimedPatrol.ticket.kind,
    '相同 session 的请求不能仅凭自报来源得到不同的授权类型');
});

test('现有真实 hook 对照：后台与管理员 session 的凭据行为不同', async () => {
  await withHook(false, async (call) => {
    const ownerLogin = await call('mcp__xiaoheihe__interactive_login', 'owner', session);
    const patrolLogin = await call('mcp__xiaoheihe__interactive_login', 'patrol', 'separate-patrol');
    assert.equal(ownerLogin.decision, 'allow');
    assert.equal(patrolLogin.decision, 'deny');
    assert.equal(patrolLogin.reason, 'credential-requires-user-present');
  });
});

test('现有真实 hook 对照：后台与管理员 session 的写入行为不同', async () => {
  await withHook(false, async (call) => {
    const ownerWrite = await call('mcp__xiaoheihe__publish_content', 'owner', session);
    const patrolWrite = await call('mcp__xiaoheihe__publish_content', 'patrol', 'separate-patrol');
    assert.equal(ownerWrite.decision, 'allow');
    assert.equal(patrolWrite.decision, 'deny');
    assert.equal(patrolWrite.reason, 'read-only-background');
  });
});

test('共享 owner session 的写入走真实 hook 额度票据，重复提交不重复计数', async () => {
  await withHook(false, async (call, commit, persistedState) => {
    const write = await call('mcp__xiaoheihe__publish_content', 'shared');
    assert.equal(write.decision, 'allow');
    assert.equal(write.exemption, 'quota');
    assert.equal(write.ticket.state, 'reserved');
    const first = await commit(write.ticket);
    assert.equal(first.ok, true);
    assert.equal(first.started, true);
    assert.equal(first.used, 1);
    const repeated = await commit(write.ticket);
    assert.equal(repeated.ok, true);
    assert.equal(repeated.already, true);
    assert.equal((await persistedState()).buckets.post.count, 1);
  });
});
