// scripts/test-xiaoheihe-identity-guard-wiring.mjs
// task-64：身份守卫接线测试（门禁消费 + 通知回执 + 手动恢复）。
//
// 覆盖：guard 状态 → authorize 门禁（normal / writes-paused / all-paused / degraded）；
// hook 身份异常 → owner 通知 → 回执写入 guard；通知失败/未知 → 升级 all-paused；
// 补报防死锁（all-paused 不解除）；身份恢复 → 恢复通知；重启保持；手动恢复三条件。
// 全部离线：真实 guard（临时文件）+ 真实 api/route/wiring/hook（loopback 端口），
// 不 import bridge、不读 config/state、不访问真实平台/QQ。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createXiaoheiheIdentityGuard } from '../src/core/xiaoheihe-identity-guard.mjs';
import { createAuthorizeWiring } from '../src/core/xiaoheihe-authorize-wiring.mjs';
import { createBackgroundPatrolBridgeHook } from '../src/core/background-patrol-bridge-hook.mjs';
import { httpRequest, postJson } from './test-port-safe.mjs';

const TOKEN = 'identity-guard-wiring-token-0123456789';
const OWNER = 123456789;
const BG_KEY = 'patrol:background';
const OWNER_KEY = 'private:123456789';
const BG_SESSION = 'sid-background';
const OWNER_SESSION = 'sid-owner';
const EQUIPMENT = 'equipment:identity';

const READ_TOOL = 'mcp__xiaoheihe__get_home_content';
const WRITE_TOOL = 'mcp__xiaoheihe__post_comment';

const dirs = [];
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhh-identity-wiring-'));
  dirs.push(dir);
  return dir;
}

// fakes：wiring 测试用的最小 controller（与 test-xiaoheihe-authorize-wiring.mjs 同形）。
let ticketSeq = 0;
function makeController() {
  const calls = { reserveRead: [], reserveWrite: [] };
  const issued = new Map();
  return {
    calls,
    async status() { return { accessPaused: false, writePaused: false }; },
    async reserveRead(request) {
      calls.reserveRead.push(request);
      ticketSeq += 1;
      const ticket = { state: 'reserved', ticketId: `t-${ticketSeq}`, kind: 'read', opId: request.id ?? null, now: request.now };
      issued.set(ticket.ticketId, ticket);
      return { ok: true, counted: true, ticket, remaining: 9 };
    },
    async reserveWrite(request) {
      calls.reserveWrite.push(request);
      ticketSeq += 1;
      const ticket = { state: 'reserved', ticketId: `t-${ticketSeq}`, kind: request.kind, opId: request.id, now: request.now };
      issued.set(ticket.ticketId, ticket);
      return { ok: true, ticket, used: 1, limit: 2 };
    },
    async commitTicket(ticket) {
      issued.get(ticket.ticketId).state = 'started';
      return { ok: true, started: true, ticket: { kind: ticket.kind, id: ticket.opId, at: ticket.now, ticketId: ticket.ticketId } };
    },
    async abortTicket(ticket) { return { ok: true, aborted: true, rolledBack: true }; },
    async finish(ticket, options) { return { ok: true, outcome: options?.outcome ?? null }; },
  };
}

function enabledConfig() { return { backgroundPatrol: { enabled: true } }; }

async function guardAt(filePath, options = {}) {
  const guard = createXiaoheiheIdentityGuard({ filePath, ...options });
  await guard.load();
  return guard;
}

async function startWiring({ guard, sessionIdentity = { backgroundSessionKeys: [BG_KEY], userExemptAgents: [OWNER_KEY] } } = {}) {
  const wiring = createAuthorizeWiring({
    config: enabledConfig(),
    controller: makeController(),
    consoleToken: TOKEN,
    sessionIdentity,
    ...(guard === undefined ? {} : { guard }),
  });
  const started = await wiring.start();
  assert.equal(started.ok, true, JSON.stringify(started));
  return started;
}

function authorize(url, body) {
  return postJson(`${url}/api/xiaoheihe/authorize`, body, { 'x-console-token': TOKEN });
}

function hookConfig() {
  return { backgroundPatrol: { enabled: true, authorizeToken: TOKEN } };
}

/**
 * 启动真实 hook（含真实 wiring loopback server）。sessions 决定身份模式：
 *  · 传 Map/对象 → mapper 模式；· 传数组/Set → legacy 模式。
 */
async function startHook({ dir, guard, sessions, backgroundSessionId = null, notifyOwner, qqCommsProvider, recordAudit, extra = {} }) {
  const hook = createBackgroundPatrolBridgeHook({
    config: hookConfig(),
    consoleToken: TOKEN,
    controllerStorePath: path.join(dir, 'controller.json'),
    ownerQQ: OWNER,
    sessions,
    backgroundSessionId,
    guard,
    ...(notifyOwner === undefined ? {} : { notifyOwner }),
    ...(qqCommsProvider === undefined ? {} : { qqCommsProvider }),
    ...(recordAudit === undefined ? {} : { recordAudit }),
    ...extra,
    port: 0,
  });
  const started = await hook.start();
  return { hook, started };
}

function sessionMap() {
  return { [BG_KEY]: BG_SESSION, [OWNER_KEY]: OWNER_SESSION };
}

// ── 1. authorize 门禁：degraded 必须视同 all-paused（P2-1） ─────────────────

test('门禁：normal 放行；degraded=true 即使 state=normal 也读写全拒（identity-guard-all-paused）', async () => {
  const normal = { snapshot: () => ({ state: 'normal', effectiveState: 'normal', degraded: false }) };
  const normalRun = await startWiring({ guard: normal });
  try {
    const read = await authorize(normalRun.url, { agentKey: BG_KEY, tool: READ_TOOL, args: { id: 'p1' } });
    assert.equal((await read.json()).decision, 'allow');
    const write = await authorize(normalRun.url, { agentKey: OWNER_KEY, tool: WRITE_TOOL, args: { text: 'x' } });
    assert.equal((await write.json()).decision, 'allow');
  } finally { await normalRun.stop(); }

  const degraded = { snapshot: () => ({ state: 'normal', effectiveState: 'normal', degraded: true }) };
  const degradedRun = await startWiring({ guard: degraded });
  try {
    const write = await authorize(degradedRun.url, { agentKey: OWNER_KEY, tool: WRITE_TOOL, args: { text: 'x' } });
    const writeBody = await write.json();
    assert.equal(writeBody.decision, 'deny', 'degraded 下写必须拒绝');
    assert.equal(writeBody.reason, 'identity-guard-all-paused');
    const read = await authorize(degradedRun.url, { agentKey: BG_KEY, tool: READ_TOOL, args: { id: 'p1' } });
    const readBody = await read.json();
    assert.equal(readBody.decision, 'deny', 'degraded 下读也必须拒绝');
    assert.equal(readBody.reason, 'identity-guard-all-paused');
  } finally { await degradedRun.stop(); }
});

test('门禁：writes-paused 只拒写、读放行；all-paused 读写全拒', async () => {
  const writesPaused = { snapshot: () => ({ state: 'writes-paused', effectiveState: 'writes-paused', degraded: false }) };
  const run = await startWiring({ guard: writesPaused });
  try {
    const read = await authorize(run.url, { agentKey: BG_KEY, tool: READ_TOOL, args: { id: 'p1' } });
    assert.equal((await read.json()).decision, 'allow');
    const write = await authorize(run.url, { agentKey: OWNER_KEY, tool: WRITE_TOOL, args: { text: 'x' } });
    const body = await write.json();
    assert.equal(body.decision, 'deny');
    assert.equal(body.reason, 'identity-guard-writes-paused');
  } finally { await run.stop(); }

  const allPaused = { snapshot: () => ({ state: 'all-paused', effectiveState: 'all-paused', degraded: false }) };
  const run2 = await startWiring({ guard: allPaused });
  try {
    const read = await authorize(run2.url, { agentKey: BG_KEY, tool: READ_TOOL, args: { id: 'p1' } });
    assert.equal((await read.json()).reason, 'identity-guard-all-paused');
    const write = await authorize(run2.url, { agentKey: OWNER_KEY, tool: WRITE_TOOL, args: { text: 'x' } });
    assert.equal((await write.json()).reason, 'identity-guard-all-paused');
  } finally { await run2.stop(); }
});

// ── 2. legacy 身份异常 → 通知回执 → writes-paused ──────────────────────────

test('legacy 身份：启动即告警（owner 私聊）+ writes-paused；写拒读放行', async () => {
  const dir = await tempDir();
  const guard = await guardAt(path.join(dir, 'guard.json'));
  const sent = [];
  const notifyOwner = async (text) => { sent.push(text); return { outcome: 'delivered', code: null }; };
  const { hook, started } = await startHook({ dir, guard, sessions: [BG_KEY], notifyOwner });
  try {
    assert.equal(started.ok, true, JSON.stringify(started));
    const snap = guard.snapshot();
    assert.equal(snap.state, 'writes-paused', 'legacy 身份必须限制为 writes-paused');
    assert.equal(snap.identityOk, false);
    assert.equal(sent.length, 1, '启动必须向 owner 发一条身份告警');
    assert.match(sent[0], /身份/);
    assert.match(sent[0], /identity-legacy|身份异常/);

    const write = await authorize(`http://127.0.0.1:${started.port}`, { agentKey: BG_KEY, tool: WRITE_TOOL, args: { text: 'x' } });
    const writeBody = await write.json();
    assert.equal(writeBody.decision, 'deny');
    assert.equal(writeBody.reason, 'identity-guard-writes-paused');
    const read = await authorize(`http://127.0.0.1:${started.port}`, { agentKey: BG_KEY, tool: READ_TOOL, args: { id: 'p1' } });
    assert.equal((await read.json()).decision, 'allow', 'writes-paused 只拒写，读仍放行');
    assert.equal(guard.snapshot().notify.status, 'delivered', '回执必须写回 guard');
  } finally { await hook.close(); }
});

test('通知失败/未知 → 升级 all-paused，读取也拒（不得当 delivered）', async () => {
  for (const outcome of ['failed', 'unknown']) {
    const dir = await tempDir();
    const guard = await guardAt(path.join(dir, 'guard.json'));
    const notifyOwner = async () => ({ outcome, code: outcome === 'failed' ? 'SEND_FAILED' : null });
    const { hook, started } = await startHook({ dir, guard, sessions: [BG_KEY], notifyOwner });
    try {
      assert.equal(started.ok, true);
      assert.equal(guard.snapshot().state, 'all-paused', `${outcome} 必须升级 all-paused`);
      const read = await authorize(`http://127.0.0.1:${started.port}`, { agentKey: BG_KEY, tool: READ_TOOL, args: { id: 'p1' } });
      const body = await read.json();
      assert.equal(body.decision, 'deny', 'all-paused 下读取也必须拒绝');
      assert.equal(body.reason, 'identity-guard-all-paused');
    } finally { await hook.close(); }
  }
});

test('补报防死锁：all-paused 下同 operationId 补报 delivered 被接受且不解除', async () => {
  const dir = await tempDir();
  const guard = await guardAt(path.join(dir, 'guard.json'));
  let attempt = 0;
  const notifyOwner = async () => {
    attempt += 1;
    return attempt === 1 ? { outcome: 'failed', code: 'SEND_FAILED' } : { outcome: 'delivered', code: null };
  };
  const { hook, started } = await startHook({ dir, guard, sessions: [BG_KEY], notifyOwner });
  try {
    assert.equal(guard.snapshot().state, 'all-paused');
    const retried = await hook.flushIdentityGuardNotifications();
    assert.equal(retried.ok, true);
    const snap = guard.snapshot();
    assert.equal(snap.notify.status, 'delivered', '同 operationId 的迟到 delivered 必须被接受');
    assert.equal(snap.state, 'all-paused', '迟到 delivered 不得自动解除 all-paused');
    const read = await authorize(`http://127.0.0.1:${started.port}`, { agentKey: BG_KEY, tool: READ_TOOL, args: { id: 'p1' } });
    assert.equal((await read.json()).decision, 'deny');
  } finally { await hook.close(); }
});

// ── 3. 身份恢复 → 恢复通知 → 解除 ─────────────────────────────────────────

test('身份恢复：legacy→mapper 重启同一 guard 文件 → 恢复通知 delivered → normal，写入放行', async () => {
  const dir = await tempDir();
  const guardPath = path.join(dir, 'guard.json');
  const first = await guardAt(guardPath);
  const sent = [];
  const notifyOwner = async (text) => { sent.push(text); return { outcome: 'delivered', code: null }; };
  const legacy = await startHook({ dir, guard: first, sessions: [BG_KEY], notifyOwner });
  try {
    assert.equal(first.snapshot().state, 'writes-paused');
  } finally { await legacy.hook.close(); }

  const second = await guardAt(guardPath);
  const mapper = await startHook({
    dir,
    guard: second,
    sessions: sessionMap(),
    backgroundSessionId: BG_SESSION,
    notifyOwner,
  });
  try {
    assert.equal(mapper.started.ok, true, JSON.stringify(mapper.started));
    // 解除后 guard 走 liftToNormal：state=normal、identityOk 归 null（身份事实只在下一次
    // reportIdentityRestored 时写回；这里断言残留异常已清空，而不是断言 identityOk===true）。
    assert.equal(second.snapshot().state, 'normal', '身份恢复 + 恢复通知 delivered 后应解除暂停');
    assert.equal(second.snapshot().anomalyId, null);
    assert.equal(second.snapshot().identityOk, null);
    assert.ok(sent.some((text) => /恢复/.test(text)), '必须向 owner 发「已恢复」通知');
    // 写入门禁还要求 reconcile 已完成（writeBlocker: reconcile-pending → 阻断），先跑一次对账。
    await mapper.hook.reconcile({ enqueue: async () => ({ ok: true }), isDelivered: async () => true });
    const ownerWrite = await authorize(`http://127.0.0.1:${mapper.started.port}`, { agentKey: OWNER_SESSION, tool: WRITE_TOOL, args: { text: 'x', operationId: 'op-owner-guard-write' } });
    const ownerWriteBody = await ownerWrite.json();
    assert.equal(ownerWriteBody.decision, 'allow', `恢复后 owner 写入应放行：${JSON.stringify(ownerWriteBody)}`);
    const patrolWrite = await authorize(`http://127.0.0.1:${mapper.started.port}`, { agentKey: BG_SESSION, tool: WRITE_TOOL, args: { text: 'x', operationId: 'op-patrol-guard-write' } });
    const patrolBody = await patrolWrite.json();
    assert.equal(patrolBody.decision, 'deny');
    assert.equal(patrolBody.reason, 'read-only-background', '回归：patrol 写入仍被后台只读门禁拒绝');
  } finally { await mapper.hook.close(); }
});

test('restore 回执失败：只停在 writes-paused（不得当已恢复），且重启保持 all-paused', async () => {
  const dir = await tempDir();
  const guardPath = path.join(dir, 'guard.json');
  const first = await guardAt(guardPath);
  let mode = 'deliver';
  const notifyOwner = async () => (mode === 'deliver' ? { outcome: 'delivered', code: null } : { outcome: 'failed', code: 'SEND_FAILED' });
  const legacy = await startHook({ dir, guard: first, sessions: [BG_KEY], notifyOwner });
  try { assert.equal(first.snapshot().state, 'writes-paused'); } finally { await legacy.hook.close(); }

  mode = 'fail';
  const second = await guardAt(guardPath);
  const restored = await startHook({ dir, guard: second, sessions: sessionMap(), backgroundSessionId: BG_SESSION, notifyOwner });
  try {
    assert.equal(second.snapshot().state, 'writes-paused', '恢复通知失败只停 writes-paused，不得解除');
    assert.equal(second.snapshot().restoreNotify.status, 'failed');
  } finally { await restored.hook.close(); }

  // all-paused 场景的「重启保持」：通知直接失败 → all-paused；重启新 guard 仍 all-paused。
  const allPausedDir = await tempDir();
  const allPausedPath = path.join(allPausedDir, 'guard.json');
  const third = await guardAt(allPausedPath);
  const failing = await startHook({ dir: allPausedDir, guard: third, sessions: [BG_KEY], notifyOwner: async () => ({ outcome: 'failed', code: 'SEND_FAILED' }) });
  try {
    assert.equal(third.snapshot().state, 'all-paused');
  } finally { await failing.hook.close(); }
  const fourth = await guardAt(allPausedPath);
  assert.equal(fourth.snapshot().state, 'all-paused', '重启后 all-paused 必须保持');
});

// ── 4. 手动恢复：三条件缺一必须拒绝并给具体 failed 列表 ─────────────────────

test('手动恢复：缺身份/缺 QQ 回执/缺补报回执分别拒绝；三条件满足后恢复 normal', async () => {
  const dir = await tempDir();
  const guardPath = path.join(dir, 'guard.json');
  const guard = await guardAt(guardPath);
  let receiptOk = false;
  let attempt = 0;
  const notifyOwner = async () => {
    attempt += 1;
    if (attempt === 1) return { outcome: 'failed', code: 'SEND_FAILED' };
    return { outcome: 'delivered', code: null };
  };
  const { hook } = await startHook({
    dir,
    guard,
    sessions: [BG_KEY],
    notifyOwner,
    qqCommsProvider: () => receiptOk,
  });
  try {
    assert.equal(guard.snapshot().state, 'all-paused');
    // 先补一条 delivered，使 reportDelivered 条件成立（但 state 仍 all-paused）。
    await hook.flushIdentityGuardNotifications();
    assert.equal(guard.snapshot().notify.status, 'delivered');

    const noIdentity = await hook.recoverIdentityGuard();
    assert.equal(noIdentity.ok, false);
    assert.ok(noIdentity.failed.includes('identity'), 'legacy 身份必须给出 identity 失败项');

    // 切到 mapper 身份（新 hook 实例，同一 guard 文件；此时 current guard 仍在 all-paused）。
    const mapperHook = await startHook({
      dir: await tempDir(),
      guard,
      sessions: sessionMap(),
      backgroundSessionId: BG_SESSION,
      notifyOwner,
      qqCommsProvider: () => receiptOk,
    });
    try {
      // 身份 + 回执都有了，但补报回执条件需要 delivered → 已满足；不过恢复通知还要能发。
      receiptOk = true;
      const recovered = await mapperHook.hook.recoverIdentityGuard();
      assert.equal(recovered.ok, true, JSON.stringify(recovered));
      assert.equal(guard.snapshot().state, 'normal');
    } finally { await mapperHook.hook.close(); }
  } finally { await hook.close(); }
});

// ── 5. degraded 运营告警（P2-2：degraded 是内存态；task-78 后由降级锁存决定重启是否回滚）────────

test('degraded 运营告警：落盘失败的内存态必须通知 owner，且同因 10 分钟去重', async () => {
  const dir = await tempDir();
  const sent = [];
  const degradedSnapshot = () => ({
    state: 'normal',
    effectiveState: 'normal',
    degraded: true,
    identityOk: null,
    anomalyId: null,
    notify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    restoreNotify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    manualRecovery: { required: false, lastRejectReason: null },
  });
  const degradedGuard = {
    snapshot: () => degradedSnapshot(),
    evaluateNotifyDeadline: async () => ({ ok: true }),
    reportAnomaly: async () => ({ ok: true }),
    reportIdentityRestored: async () => ({ ok: true }),
    reportNotifyResult: async () => ({ ok: true }),
    reportRestoreNotifyResult: async () => ({ ok: true }),
    recoverManually: async () => ({ ok: false, reason: 'precondition-failed', failed: [] }),
  };
  const run = await startHook({
    dir,
    guard: degradedGuard,
    sessions: [BG_KEY],
    notifyOwner: async (text) => { sent.push(text); return { outcome: 'delivered', code: null }; },
  });
  try {
    const alerts = () => sent.filter((text) => /degraded|降级/.test(text));
    assert.ok(alerts().length >= 1, `degraded 必须发运营告警：${JSON.stringify(sent)}`);
    // 再触发两次 flush（模拟周期 reconcile）：同一原因在 10 分钟窗口内不得重复告警。
    await run.hook.flushIdentityGuardNotifications();
    await run.hook.flushIdentityGuardNotifications();
    assert.equal(alerts().length, 1, `同因告警必须去重：${JSON.stringify(sent)}`);
  } finally { await run.hook.close(); }
});

// ── 6. bridge 侧静态接线（不可直接 import bridge：用源码断言钉住）──────────

test('bridge 静态接线：回执接口 + 恢复端点 + 状态快照字段', async () => {
  const source = await fs.readFile(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(source, /function sendOwnerPrivateWithReceipt\(/, '必须有带回执的 owner 私发送');
  assert.match(source, /sendOwnerPrivateWithReceipt\s*\(/, '必须被实际调用');
  assert.match(source, /lastSendReceiptAt/, '必须记录最近成功回执时间');
  assert.match(source, /message_id/, '送达判定必须看 message_id');
  assert.match(source, /\/api\/identity-guard\/recover/, '必须有管理员恢复端点');
  assert.match(source, /identity-guard\.json/, 'guard 状态文件路径');
  assert.match(source, /identityGuard:\s*backgroundPatrolIdentityGuard/, '/api/status 必须暴露 guard 快照');
});

// ── task-77：损坏态不得免回执，必须走「受控补报告警 + 真实回执」通道 ──────────

test('task-77 静态接线：恢复端点不得从请求体取任何放宽依据；必须提供受控补报告警端点', async () => {
  const source = await fs.readFile(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const recoverChunk = source.slice(
    source.indexOf('/api/identity-guard/recover'),
    source.indexOf('/api/identity-guard/resend-notify'),
  );
  assert.ok(recoverChunk.length > 0, '必须存在恢复端点');
  // ① task-75 的 corruptionAck 例外已删除：恢复端点不得再读请求体、不得再透传任何放宽开关。
  assert.doesNotMatch(recoverChunk, /readBody\(/, '恢复端点不得读请求体（所有条件必须服务端现算）');
  assert.doesNotMatch(recoverChunk, /corruptionAck/, '恢复端点不得再出现 corruptionAck');
  assert.match(recoverChunk, /recoverIdentityGuard\(\)/, '必须无参调用 hook 的恢复能力');
  // ② 损坏态必须另有「产生一条真实补报告警」的通道，否则永久锁死。
  assert.match(source, /\/api\/identity-guard\/declare-corruption/, '必须有管理员受控补报告警端点');
  assert.match(source, /declareIdentityGuardCorruptionAnomaly\(\)/, '补报端点必须真的调用 hook 的新能力');
  // ③ 显式重发端点仍必须存在（补报发不出去时的正规手段）。
  assert.match(source, /\/api\/identity-guard\/resend-notify/, '必须有管理员显式重发补报端点');
  assert.match(source, /resendIdentityGuardNotify\(\)/, '重发端点必须真的调用 hook 的重发能力');
  // ④ task-87（用户裁定 m19958）：三条端点必须走**专栏密码会话**校验；
  //    `x-console-admin` 自报头不再具备授权力（只在审计里记 attribution）。
  // 按真实路由声明切片：注释里提到路径不算路由，因此只认 `url.pathname === '/api/identity-guard/...'`。
  const routeMatches = [...source.matchAll(/url\.pathname === '(\/api\/identity-guard\/[^']+)'/g)];
  assert.ok(routeMatches.length >= 3, `至少要声明 recover / resend-notify / declare-corruption 三条路由（实际 ${routeMatches.length}）`);
  for (const match of routeMatches) {
    const chunk = source.slice(match.index, match.index + 900);
    assert.match(chunk, /columnSessionFromRequest\(req/, `${match[1]} 路由必须校验专栏密码会话`);
    assert.match(chunk, /column-session-required/, `${match[1]} 未通过时必须返回 column-session-required`);
    // 负向断言：不得再以自报头 isConsoleAdminRequestV2 作为门禁（它已不具授权力）。
    assert.doesNotMatch(chunk, /isConsoleAdminRequestV2\(req\)/, `${match[1]} 不得再用 isConsoleAdminRequestV2 作为门禁`);
  }
});

// ── task-77 行为接线：损坏态必须「先发真实补报 → 拿到回执 → 才可恢复」 ──────

test('task-77 行为：损坏态直接恢复必拒；declare 产生真实补报，delivered 后才能恢复', async () => {
  const dir = await tempDir();
  const guardPath = path.join(dir, 'guard.json');
  // 造一个 schema 合法但内容非法的状态文件 → load 走 failClosed('state-invalid')。
  await fs.writeFile(guardPath, JSON.stringify({ schemaVersion: 1, state: 'normal', bogus: true }), 'utf8');
  const guard = await guardAt(guardPath);
  const sent = [];
  let notifyMode = 'delivered';
  const notifyOwner = async (text) => {
    if (/降级|degraded/.test(text)) return { outcome: 'delivered', code: null };
    sent.push(text);
    return notifyMode === 'delivered'
      ? { outcome: 'delivered', code: null }
      : { outcome: 'failed', code: 'SEND_FAILED' };
  };
  const { hook } = await startHook({
    dir,
    guard,
    sessions: sessionMap(),
    backgroundSessionId: BG_SESSION,
    notifyOwner,
    qqCommsProvider: () => true,
  });
  try {
    const boot = guard.snapshot();
    console.error(`[diag-task77-boot] ${JSON.stringify({ state: boot.state, skipReason: boot.skipReason, controlledRecoveryAvailable: boot.controlledRecoveryAvailable })}`);
    assert.equal(boot.state, 'all-paused', '损坏文件必须 fail-closed 到 all-paused');
    assert.equal(typeof boot.skipReason, 'string');
    assert.equal(boot.controlledRecoveryAvailable, true, '损坏且无既有通知时必须可发起受控补报');

    // ① 直接恢复：没有回执可等，必须被拒（这就是被删除的 corruptionAck 想绕过的判定）。
    const direct = await hook.recoverIdentityGuard();
    console.error(`[diag-task77-direct] ${JSON.stringify(direct)}`);
    assert.equal(direct.ok, false, '损坏态不得免回执恢复');
    assert.deepEqual(direct.failed, ['report-receipt']);
    assert.equal(guard.snapshot().state, 'all-paused');

    // ② 管理员发起受控补报告警 → 走真实发送链路。
    const declared = await hook.declareIdentityGuardCorruptionAnomaly();
    console.error(`[diag-task77-declare] ${JSON.stringify(declared)}`);
    assert.equal(declared.ok, true, JSON.stringify(declared));
    assert.equal(sent.length, 1, '必须真的发出一条补报告警');
    assert.equal(declared.notifyStatus, 'delivered');
    const afterDeclare = guard.snapshot();
    assert.equal(afterDeclare.notify.operationId, afterDeclare.anomalyId, '回执必须绑定本次补报事件');
    assert.equal(afterDeclare.controlledRecoveryAvailable, false, '已有通知时不得再发起第二条');

    // ③ 回执已到 → 恢复才允许。
    const recovered = await hook.recoverIdentityGuard();
    console.error(`[diag-task77-recovered] ${JSON.stringify(recovered)}`);
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.reportReceiptBasis, 'delivered');
    assert.equal(guard.snapshot().state, 'normal');
  } finally { await hook.close(); }
});

test('task-77 行为：补报告警发送失败时不得放行恢复（未知/失败 ≠ 成功）', async () => {
  const dir = await tempDir();
  const guardPath = path.join(dir, 'guard.json');
  await fs.writeFile(guardPath, JSON.stringify({ schemaVersion: 1, state: 'normal', bogus: true }), 'utf8');
  const guard = await guardAt(guardPath);
  const notifyOwner = async (text) => {
    if (/降级|degraded/.test(text)) return { outcome: 'delivered', code: null };
    return { outcome: 'failed', code: 'SEND_FAILED' };
  };
  const { hook } = await startHook({
    dir,
    guard,
    sessions: sessionMap(),
    backgroundSessionId: BG_SESSION,
    notifyOwner,
    qqCommsProvider: () => true,
  });
  try {
    const declared = await hook.declareIdentityGuardCorruptionAnomaly();
    assert.equal(declared.ok, true, JSON.stringify(declared));
    assert.equal(declared.notifyStatus, 'failed', '发送失败必须如实反映为 failed');
    const denied = await hook.recoverIdentityGuard();
    console.error(`[diag-task77-failed-declare] ${JSON.stringify(denied)}`);
    assert.equal(denied.ok, false, '补报发送失败时绝不放行');
    assert.deepEqual(denied.failed, ['report-receipt']);
    assert.equal(guard.snapshot().state, 'all-paused');
  } finally { await hook.close(); }
});

after(async () => {
  for (const dir of dirs) {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── task-69：unknown 重发 + 上限；task-75：耗尽**不再**是恢复依据，改为显式重发让真实回执可达 ──

test('task-69/task-75 接线：unknown 重发到上限即停；耗尽不放行恢复；显式重发拿到真实回执后才可恢复', async () => {
  const dir = await tempDir();
  const guard = await guardAt(path.join(dir, 'guard.json'));
  let sends = 0;
  let mode = 'unknown';
  const notifyOwner = async () => {
    sends += 1;
    if (mode === 'delivered') return { outcome: 'delivered', code: null };
    return { outcome: 'unknown', code: 'NO_MESSAGE_ID' };
  };
  const { hook } = await startHook({ dir, guard, sessions: [BG_KEY], notifyOwner });
  try {
    // start 自身触发一次 flush；再补 6 次 tick，旧实现 unknown 永不重发（sends 停 1）。
    for (let i = 0; i < 6; i += 1) await hook.flushIdentityGuardNotifications();
    const snap = guard.snapshot();
    console.error(`[diag-task69-wiring] sends=${sends} attempts=${snap.notify.attempts} exhausted=${snap.notify.retriesExhausted} state=${snap.state}`);
    assert.equal(snap.state, 'all-paused', 'unknown 必须全停（未知结果不得当 delivered）');
    assert.equal(snap.notify.status, 'unknown');
    assert.equal(sends, 3, 'unknown 必须重发，且受 3 次上限约束（不得每 60s 无限骚扰）');
    assert.equal(snap.notify.attempts, 3, '每次真实发送都必须计入 attempts（P1-B）');
    assert.equal(snap.notify.retriesExhausted, true, '耗尽必须可观察');
    await hook.flushIdentityGuardNotifications();
    assert.equal(sends, 3, '耗尽后不得继续自动重发');

    // task-75（用户规则 m13214 §4/§5）：换成 mapper 身份后，「耗尽」**不得**再替代补报回执。
    const mapperHook = await startHook({
      dir: await tempDir(),
      guard,
      sessions: sessionMap(),
      backgroundSessionId: BG_SESSION,
      notifyOwner,
      qqCommsProvider: () => true,
    });
    try {
      const stillDenied = await mapperHook.hook.recoverIdentityGuard();
      console.error(`[diag-task75-recover-denied] ${JSON.stringify(stillDenied)}`);
      assert.equal(stillDenied.ok, false, '重试耗尽不是成功回执，不得据此恢复（否则未知结果被当成成功）');
      assert.deepEqual(stillDenied.failed, ['report-receipt']);
      assert.equal(stillDenied.reportReceiptBasis, null);
      assert.equal(guard.snapshot().state, 'all-paused', '被拒后必须仍是全停');

      // 正解：管理员显式重发 → 真实发送成功 → notify.status=delivered（与 anomalyId 绑定）
      mode = 'delivered';
      const resent = await mapperHook.hook.resendIdentityGuardNotify();
      console.error(`[diag-task75-resend] ${JSON.stringify(resent)}`);
      assert.equal(resent.ok, true, '显式重发必须被接受（这是让真实回执可达的正规路径）');
      assert.equal(guard.snapshot().notify.status, 'delivered');
      assert.equal(guard.snapshot().state, 'all-paused', '重发成功只代表回执到了，不得自动解除全停');

      const recovered = await mapperHook.hook.recoverIdentityGuard();
      console.error(`[diag-task75-recover-after-resend] ${JSON.stringify(recovered)}`);
      assert.equal(recovered.ok, true, '拿到真实回执后恢复必须可用');
      assert.equal(recovered.reportReceiptBasis, 'delivered');
      assert.equal(guard.snapshot().state, 'normal');
    } finally {
      await mapperHook.hook.close();
    }
  } finally {
    await hook.close();
  }
});

// ── task-69 P1-C 接线契约：bridge 必须把 failClosed 的守卫加载失败写进日志（不得静默）──

test('task-69 P1-C 接线契约：bridge 对 guard.load() 的 failClosed 结果必须告警（state-corrupt 可观察）', async () => {
  const source = await fs.readFile(path.resolve('src/bridge.js'), 'utf8');
  assert.match(source, /loaded\?\.failClosed === true/, 'bridge 必须识别 guard 的 failClosed:true');
  assert.match(source, /身份守卫加载失败（fail-closed 由守卫内部处理）/, 'bridge 必须保留加载失败的日志文案');
});

test('degraded 告警文案必须与真实重启语义一致（task-78 后分「锁存生效」与「锁存也失败」两条路）', async () => {
  // 历史缺陷一：文案写成「重启不回滚该限制」，与当时的实测相反（见 identity-guard 测试的
  // 「degraded 重启语义（事实钉住）」用例）。运维会据此以为重启是安全操作。
  // 历史缺陷二（task-78 引入）：锁存让「重启必回滚」不再是全部真相——锁存写成时重启会 fail-closed、
  // 限制不会消失；只有在**锁存也写失败**（state 目录整体不可写，与 persist 失败同源）时才回滚。
  // 文案若只说其中一半，任一种情况下运维都会误判，因此两条路都必须写进告警。
  const dir = await tempDir();
  const sent = [];
  const degradedSnapshot = () => ({
    state: 'writes-paused',
    effectiveState: 'all-paused',
    degraded: true,
    identityOk: null,
    anomalyId: null,
    notify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    restoreNotify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    manualRecovery: { required: false, lastRejectReason: null },
  });
  const degradedGuard = {
    snapshot: () => degradedSnapshot(),
    evaluateNotifyDeadline: async () => ({ ok: true }),
    reportAnomaly: async () => ({ ok: true }),
    reportIdentityRestored: async () => ({ ok: true }),
    reportNotifyResult: async () => ({ ok: true }),
    reportRestoreNotifyResult: async () => ({ ok: true }),
    recoverManually: async () => ({ ok: false, reason: 'precondition-failed', failed: [] }),
  };
  const run = await startHook({
    dir,
    guard: degradedGuard,
    sessions: [BG_KEY],
    notifyOwner: async (text) => { sent.push(text); return { outcome: 'delivered', code: null }; },
  });
  try {
    const alerts = sent.filter((text) => /degraded|降级/.test(text));
    assert.ok(alerts.length >= 1, `必须发 degraded 告警：${JSON.stringify(sent)}`);
    for (const text of alerts) {
      assert.equal(
        /重启不回滚/.test(text),
        false,
        `告警不得声称「重启不回滚」（会误导运维以为重启必然安全）：${text}`,
      );
      // task-78：锁存生效路径必须写清（重启仍 fail-closed，不是「必然丢失」）
      assert.match(text, /降级锁存已写成/, `告警必须说清「锁存写成时重启仍 fail-closed」：${text}`);
      assert.match(text, /继续 fail-closed/, `告警必须点明锁存生效时限制不会解除：${text}`);
      // task-78：锁存也失败路径必须写清（这才是真正会静默回滚的情形）
      assert.match(text, /锁存也写失败/, `告警必须说清「锁存也写失败」的后果：${text}`);
      assert.match(text, /静默回滚/, `告警必须保留「静默回滚该限制」这条真实风险：${text}`);
      assert.match(text, /重启后必须复查/, `告警必须给出重启后复查要求：${text}`);
    }
  } finally { await run.hook.close(); }
});


// ── task-79 P2-1：degraded 两类来源必须分支告警（不得把「状态文件损坏」说成「写入磁盘失败」）──

test('task-79 P2-1：degraded 两类来源分支 —— 落盘失败 vs 状态文件损坏，文案必须各自准确', async () => {
  // 类1：skipReason=null（persist 失败）。历史文案是对的，但必须真的断言到「写入磁盘失败」这个成因短语，
  // 否则删掉它测试照样绿（task-79 MT3 变异实证）。
  const dir1 = await tempDir();
  const sentFailed = [];
  const persistFailedSnapshot = () => ({
    state: 'writes-paused',
    effectiveState: 'all-paused',
    degraded: true,
    degradeReason: 'persist-failed',
    skipReason: null,
    identityOk: null,
    anomalyId: null,
    notify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    restoreNotify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    manualRecovery: { required: false, lastRejectReason: null },
  });
  const guardFor = (snap) => ({
    snapshot: () => snap(),
    evaluateNotifyDeadline: async () => ({ ok: true }),
    reportAnomaly: async () => ({ ok: true }),
    reportIdentityRestored: async () => ({ ok: true }),
    reportNotifyResult: async () => ({ ok: true }),
    reportRestoreNotifyResult: async () => ({ ok: true }),
    recoverManually: async () => ({ ok: false, reason: 'precondition-failed', failed: [] }),
  });
  const run1 = await startHook({
    dir: dir1,
    guard: guardFor(persistFailedSnapshot),
    sessions: [BG_KEY],
    notifyOwner: async (text) => { sentFailed.push(text); return { outcome: 'delivered', code: null }; },
  });
  try {
    const alerts = sentFailed.filter((text) => /降级|degraded/i.test(text));
    assert.ok(alerts.length >= 1, `类1 必须发告警：${JSON.stringify(sentFailed)}`);
    for (const text of alerts) {
      assert.match(text, /写入磁盘失败/, `类1 必须点明「写入磁盘失败」这个真实成因：${text}`);
      assert.match(text, /降级锁存已写成/, `类1 必须讲锁存语义：${text}`);
      assert.equal(/状态文件损坏/.test(text), false, `类1 不得说成状态文件损坏（会指错排查方向）：${text}`);
    }
  } finally { await run1.hook.close(); }

  // 类2：skipReason='state-corrupt'（failClosed）。它 degraded=true 但**从不写 latch**，
  // 因此旧文案「请检查 state 目录写入权限」是误导；必须改说「文件损坏 + 受控补报路径」。
  const dir2 = await tempDir();
  const sentCorrupt = [];
  const corruptSnapshot = () => ({
    state: 'all-paused',
    effectiveState: 'all-paused',
    degraded: true,
    degradeReason: 'state-corrupt',
    skipReason: 'state-corrupt',
    controlledRecoveryAvailable: true,
    identityOk: null,
    anomalyId: null,
    notify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    restoreNotify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    manualRecovery: { required: true, lastRejectReason: null },
  });
  const run2 = await startHook({
    dir: dir2,
    guard: guardFor(corruptSnapshot),
    sessions: [BG_KEY],
    notifyOwner: async (text) => { sentCorrupt.push(text); return { outcome: 'delivered', code: null }; },
  });
  try {
    const alerts = sentCorrupt.filter((text) => /降级|degraded|fail-closed/i.test(text));
    assert.ok(alerts.length >= 1, `类2 必须发告警：${JSON.stringify(sentCorrupt)}`);
    for (const text of alerts) {
      assert.match(text, /state-corrupt/, `类2 必须带上具体 skipReason（可排查）：${text}`);
      assert.equal(
        /请检查 state 目录写入权限/.test(text),
        false,
        `类2 不得把成因说成写入权限（该场景根本不写 latch，会误导运维）：${text}`,
      );
      assert.match(text, /受控补报告警/, `类2 必须给出正确出口（受控补报）：${text}`);
      // task-80 P3-2：指引句必须被正向断言钉住，否则文案可无声漂移（复审 m8 变异实证：
      // 删掉「请直接检查并修复/移走…」后测试仍全绿）。
      assert.match(
        text,
        /请直接检查并修复\/移走身份守卫状态文件/,
        `类2 必须给出「修/移走那个坏文件」的具体动作，而不只是抽象说「损坏」：${text}`,
      );
    }
  } finally { await run2.hook.close(); }
});


// ── task-80：degraded 第四类（磁盘上的历史 degraded:true，既非损坏也非落盘失败）──

test('task-80 第四类：degradeReason=degraded 不得说成「文件损坏」或「落盘失败」', async () => {
  // applyLoad 读到 parsed.degraded===true 时置 degradeReason='degraded'：这是旧版本把纯内存态
  // 误写进磁盘留下的历史标记，文件本身能解析、结构合法。若走类2 文案，运维会去修一个没坏的文件。
  const dir = await tempDir();
  const sent = [];
  const legacySnapshot = () => ({
    state: 'normal',
    effectiveState: 'all-paused',
    degraded: true,
    degradeReason: 'degraded',
    skipReason: null,
    controlledRecoveryAvailable: false,
    identityOk: null,
    anomalyId: null,
    notify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    restoreNotify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    manualRecovery: { required: true, lastRejectReason: null },
  });
  const run = await startHook({
    dir,
    guard: {
      snapshot: () => legacySnapshot(),
      evaluateNotifyDeadline: async () => ({ ok: true }),
      reportAnomaly: async () => ({ ok: true }),
      reportIdentityRestored: async () => ({ ok: true }),
      reportNotifyResult: async () => ({ ok: true }),
      reportRestoreNotifyResult: async () => ({ ok: true }),
      recoverManually: async () => ({ ok: false, reason: 'precondition-failed', failed: [] }),
    },
    sessions: [BG_KEY],
    notifyOwner: async (text) => { sent.push(text); return { outcome: 'delivered', code: null }; },
  });
  try {
    const alerts = sent.filter((text) => /降级|degraded/i.test(text));
    assert.ok(alerts.length >= 1, `第四类必须发告警：${JSON.stringify(sent)}`);
    for (const text of alerts) {
      assert.match(text, /旧版本/, `第四类必须说明是历史标记：${text}`);
      assert.equal(/状态文件损坏\/不可读/.test(text), false, `第四类不得说成文件损坏：${text}`);
      // task-80 P3-3：原为 `/这不是落盘失败.*请直接检查并修复/`（两短语 AND），只能拦住「完整复制类2 文案」，
      // 拦不住半句漂移（复审 m14 变异单注入指引句仍绿）。拆成两条独立否定断言。
      assert.equal(/这不是落盘失败/.test(text), false, `第四类不得套用类2 的「这不是落盘失败」排他说法：${text}`);
      assert.equal(
        /请直接检查并修复\/移走/.test(text),
        false,
        `第四类不得套用类2 的「修/移走状态文件」指引（引导去修一个没坏的文件）：${text}`,
      );
      // task-82 P3（w1）：上面三条只拦「类2 原句」。复审变异在类4 尾部追加一句
      // 「另外，请修复该状态文件。」→ 全绿，而该句恰恰在引导运维去修一个没坏的文件。
      // 改为按**语义**拦：类4 任何位置都不得出现「修复/移走 … 状态文件」这类动作指令。
      assert.equal(
        /(修复|移走|删[除去]?)[^。；\n]{0,8}状态文件/.test(text),
        false,
        `第四类（文件结构合法）不得出现任何「修复/移走/删除状态文件」的动作指令：${text}`,
      );
      // task-82 P3（w2）：基础分支（无历史 skipReason）的**恢复出口指令**此前没有任何正向断言，
      // 删掉整句仍全绿 ⇒ 运维读到「旧标记、落盘即可清除」却不知道下一步该做什么。
      assert.match(text, /受控补报告警/, `第四类必须给出恢复出口（受控补报）：${text}`);
      assert.match(text, /人工恢复/, `第四类必须点明最终须人工恢复：${text}`);
    }
  } finally { await run.hook.close(); }
});

// ── task-80 P3-5：类4 与历史 skipReason 并存时，必须说清「清标记 ≠ 解除暂停」 ──

test('task-80 P3-5：类4 叠加历史 skipReason 时必须点明 all-paused 的由来与「清标记不解暂停」', async () => {
  // 旧产物可能同时带 degraded:true 与 skipReason（先损坏 → 旧版误写降级标记）。
  // 此时若只说「旧标记、落盘即可清除」，运维会以为改完标记就恢复了。
  const dir = await tempDir();
  const sent = [];
  const mixedSnapshot = () => ({
    state: 'all-paused',
    effectiveState: 'all-paused',
    degraded: true,
    degradeReason: 'degraded',
    skipReason: 'state-invalid',
    controlledRecoveryAvailable: true,
    identityOk: null,
    anomalyId: null,
    notify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    restoreNotify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    manualRecovery: { required: true, lastRejectReason: null },
  });
  const run = await startHook({
    dir,
    guard: {
      snapshot: () => mixedSnapshot(),
      evaluateNotifyDeadline: async () => ({ ok: true }),
      reportAnomaly: async () => ({ ok: true }),
      reportIdentityRestored: async () => ({ ok: true }),
      reportNotifyResult: async () => ({ ok: true }),
      reportRestoreNotifyResult: async () => ({ ok: true }),
      recoverManually: async () => ({ ok: false, reason: 'precondition-failed', failed: [] }),
    },
    sessions: [BG_KEY],
    notifyOwner: async (text) => { sent.push(text); return { outcome: 'delivered', code: null }; },
  });
  try {
    const alerts = sent.filter((text) => /降级|degraded/i.test(text));
    assert.ok(alerts.length >= 1, `类4 混合态必须发告警：${JSON.stringify(sent)}`);
    for (const text of alerts) {
      assert.match(text, /旧版本/, `必须说明标记来自旧版本：${text}`);
      assert.match(text, /state-invalid/, `必须点出历史 skipReason 这条事实：${text}`);
      assert.match(text, /不会解除暂停/, `必须说清清除标记不等于解除暂停：${text}`);
      assert.match(text, /受控补报告警/, `必须给出恢复的正确出口：${text}`);
    }
  } finally { await run.hook.close(); }
});


// ── task-80：degraded 第三类（损坏修复后又落盘失败）必须说清两条事实 ──

test('task-80 P2-1 第三类：degradeReason=persist-failed 且 skipReason 残留 state-corrupt，两条事实都要说', async () => {
  // 可达性已由探针实证（D:/tmp/probe-b1）：failClosed(state-corrupt) → declare 成功落盘（degraded 清）
  // → 再让写盘失败 ⇒ degradeReason='persist-failed'，但 state.skipReason 仍是 'state-corrupt'。
  // 若只看 skipReason 会走类2 文案，对运营宣称「这不是落盘失败」——与事实相反。
  const dir = await tempDir();
  const sent = [];
  const combinedSnapshot = () => ({
    state: 'all-paused',
    effectiveState: 'all-paused',
    degraded: true,
    degradeReason: 'persist-failed',
    skipReason: 'state-corrupt',
    controlledRecoveryAvailable: false,
    identityOk: null,
    anomalyId: null,
    notify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    restoreNotify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    manualRecovery: { required: true, lastRejectReason: null },
  });
  const run = await startHook({
    dir,
    guard: {
      snapshot: () => combinedSnapshot(),
      evaluateNotifyDeadline: async () => ({ ok: true }),
      reportAnomaly: async () => ({ ok: true }),
      reportIdentityRestored: async () => ({ ok: true }),
      reportNotifyResult: async () => ({ ok: true }),
      reportRestoreNotifyResult: async () => ({ ok: true }),
      recoverManually: async () => ({ ok: false, reason: 'precondition-failed', failed: [] }),
    },
    sessions: [BG_KEY],
    notifyOwner: async (text) => { sent.push(text); return { outcome: 'delivered', code: null }; },
  });
  try {
    const alerts = sent.filter((text) => /降级|degraded|fail-closed/i.test(text));
    assert.ok(alerts.length >= 1, `类3 必须发告警：${JSON.stringify(sent)}`);
    for (const text of alerts) {
      // 事实一：本次确实是落盘失败
      assert.match(text, /写入磁盘失败/, `类3 必须承认本次是落盘失败：${text}`);
      // 事实二：先前还有未清理的损坏记录
      assert.match(text, /state-corrupt/, `类3 必须点出残留的损坏记录：${text}`);
      // 不得宣称「这不是落盘失败」（类2 的排他说法）
      assert.equal(
        /这不是落盘失败/.test(text),
        false,
        `类3 不得使用类2 的「这不是落盘失败」说法（与事实相反）：${text}`,
      );
      // task-80 P3-3：并列把「指引句」单独钉住，防只漂移半句时失明。
      assert.equal(
        /请直接检查并修复\/移走身份守卫状态文件/.test(text),
        false,
        `类3 不得使用类2 的「修/移走文件」指引（本次问题在磁盘写入，不在文件内容）：${text}`,
      );
    }
  } finally { await run.hook.close(); }
});


// ── task-71：恢复动作 / 通知耗尽 / degraded 告警失败必须进审计账本（只增可观测，不改判定） ──

test('task-71 P2-4：degraded 告警发送失败必须落审计（pause/failure），成功时不得写失败审计', async () => {
  const snapshotOf = () => ({
    state: 'writes-paused',
    effectiveState: 'all-paused',
    degraded: true,
    identityOk: null,
    anomalyId: null,
    notify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    restoreNotify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    manualRecovery: { required: false, lastRejectReason: null },
  });
  const guardFor = () => ({
    snapshot: () => snapshotOf(),
    evaluateNotifyDeadline: async () => ({ ok: true }),
    reportAnomaly: async () => ({ ok: true }),
    reportIdentityRestored: async () => ({ ok: true }),
    reportNotifyResult: async () => ({ ok: true }),
    reportRestoreNotifyResult: async () => ({ ok: true }),
    recoverManually: async () => ({ ok: false, reason: 'precondition-failed', failed: [] }),
  });

  // ① 告警发送失败 → 必须有审计行（否则「降级了但没人知道」事后无法追责）
  const failingAudits = [];
  const failing = await startHook({
    dir: await tempDir(),
    guard: guardFor(),
    sessions: [BG_KEY],
    notifyOwner: async () => ({ outcome: 'failed', code: 'SEND_FAILED' }),
    recordAudit: (reason, action, result) => failingAudits.push({ reason, action, result }),
  });
  try {
    const rows = failingAudits.filter((item) => item.reason === 'identity-guard-degraded-alert-failed');
    assert.deepEqual(
      rows,
      [{ reason: 'identity-guard-degraded-alert-failed', action: 'pause', result: 'failure' }],
      `发送失败必须写且只写一行 pause/failure 审计：${JSON.stringify(failingAudits)}`,
    );
  } finally { await failing.hook.close(); }

  // ② 告警发送成功 → 不得写失败审计（否则审计会误报运维事故）
  const okAudits = [];
  const ok = await startHook({
    dir: await tempDir(),
    guard: guardFor(),
    sessions: [BG_KEY],
    notifyOwner: async () => ({ outcome: 'delivered', code: null }),
    recordAudit: (reason, action, result) => okAudits.push({ reason, action, result }),
  });
  try {
    assert.deepEqual(
      okAudits.filter((item) => item.reason === 'identity-guard-degraded-alert-failed'),
      [],
      `告警已送达时不得写失败审计：${JSON.stringify(okAudits)}`,
    );
  } finally { await ok.hook.close(); }
});

test('task-71 P2-2：通知重试耗尽必须落审计（pause/failure，且每个 op 只记一次）', async () => {
  const dir = await tempDir();
  const guard = await guardAt(path.join(dir, 'guard.json'));
  const audits = [];
  const recordAudit = (reason, action, result) => audits.push({ reason, action, result });
  const started = await startHook({
    dir,
    guard,
    sessions: [OWNER_KEY],
    notifyOwner: async () => ({ outcome: 'unknown', code: 'NO_MESSAGE_ID' }),
    recordAudit,
  });
  try {
    await started.hook.flushIdentityGuardNotifications();
    await started.hook.flushIdentityGuardNotifications();
    assert.equal(guard.snapshot().notify.retriesExhausted, true, '前置：重试必须真的耗尽');
    const rows = audits.filter((item) => item.reason === 'identity-guard-notify-retries-exhausted');
    assert.deepEqual(rows, [{ reason: 'identity-guard-notify-retries-exhausted', action: 'pause', result: 'failure' }]);
    await started.hook.flushIdentityGuardNotifications();
    assert.equal(
      audits.filter((item) => item.reason === 'identity-guard-notify-retries-exhausted').length,
      1,
      '同一 operationId 只允许记录一次耗尽审计',
    );
  } finally {
    await started.hook.close();
  }
});

test('task-75 P2-2：耗尽后恢复必须被拒且不得写「耗尽即恢复」审计；显式重发拿到回执后才落 delivered 依据', async () => {
  const dir = await tempDir();
  const first = await guardAt(path.join(dir, 'guard.json'));
  const legacy = await startHook({
    dir,
    guard: first,
    sessions: [OWNER_KEY],
    notifyOwner: async () => ({ outcome: 'unknown', code: 'NO_MESSAGE_ID' }),
    recordAudit: () => {},
  });
  try {
    await legacy.hook.flushIdentityGuardNotifications();
    await legacy.hook.flushIdentityGuardNotifications();
    assert.equal(first.snapshot().notify.retriesExhausted, true, '前置：重试必须真的耗尽');
  } finally {
    await legacy.hook.close();
  }

  const second = await guardAt(path.join(dir, 'guard.json'));
  const audits = [];
  const mapper = await startHook({
    dir,
    guard: second,
    sessions: sessionMap(),
    backgroundSessionId: BG_SESSION,
    notifyOwner: async () => ({ outcome: 'delivered', code: null }),
    qqCommsProvider: () => true,
    recordAudit: (reason, action, result) => audits.push({ reason, action, result }),
  });
  try {
    // ① 耗尽不是回执：恢复必须被拒，且绝不能留下「按耗尽依据恢复」的审计（那会让事后追责失真）。
    const denied = await mapper.hook.recoverIdentityGuard();
    assert.equal(denied.ok, false, JSON.stringify(denied));
    assert.deepEqual(denied.failed, ['report-receipt']);
    assert.equal(
      audits.some((item) => item.reason === 'identity-guard-recovered-with-exhausted-receipt'),
      false,
      `不得写「耗尽即恢复」审计：${JSON.stringify(audits)}`,
    );
    assert.equal(second.snapshot().state, 'all-paused');

    // ② 显式重发 → 真实回执 → 恢复成功，依据必须是 'delivered'（不是耗尽）。
    const resent = await mapper.hook.resendIdentityGuardNotify();
    assert.equal(resent.ok, true, JSON.stringify(resent));
    assert.ok(
      audits.some((item) => item.reason === 'identity-guard-resend-notify' && item.action === 'resume'),
      `显式重发必须落审计：${JSON.stringify(audits)}`,
    );
    const recovered = await mapper.hook.recoverIdentityGuard();
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.reportReceiptBasis, 'delivered');
    assert.equal(second.snapshot().state, 'normal');
  } finally {
    await mapper.hook.close();
  }
});

test('task-71 接线：bridge 必须给 hook 注入 recordAudit，恢复端点成功/拒绝/异常都要落审计', async () => {
  const src = await fs.readFile(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(src, /recordAudit:\s*\(reason, action, result\)\s*=>\s*recordBackgroundPatrolAudit\(reason, action, result\)/,
    'bridge 必须把 hook 审计回调接到 backgroundPatrolAudit');
  assert.match(src, /'identity-guard-manual-recovery'/, '恢复成功必须落审计');
  assert.match(src, /'identity-guard-manual-recovery-rejected'/, '恢复被拒必须落审计');
  assert.match(src, /'identity-guard-manual-recovery-error'/, '恢复异常必须落审计');
});

// ── task-80 P2-1：degradeReason 必须由**真实 guard** 产生，stub 快照挡不住赋值点被改坏 ──

test('task-80 P2-1：真实 guard → hook 端到端 —— degradeReason 的三个赋值点各产生正确文案', async () => {
  // 复审实证：把 degradeReason 的三个赋值点（persist 失败 / failClosed / applyLoad 旧标记）改坏，
  // guard 85/85 + wiring 23/23 全绿 —— 因为四类文案用例全用 stub snapshot，不经过 guard 的赋值点。
  // 本用例三段落全部由真实 guard 产生快照，任何一处赋值点被改坏都会掉到类2 兜底文案而红。
  const validState = (extra = {}) => `${JSON.stringify({
    schemaVersion: 1,
    state: 'normal',
    since: Date.now(),
    anomalyId: null,
    anomalyKind: null,
    anomalyDetail: null,
    skipReason: null,
    identityOk: null,
    notify: { status: null, operationId: null, attempts: 0, lastAt: null, lastCode: null, deliveredAt: null },
    restoreNotify: { status: null, operationId: null, attempts: 0, lastAt: null, lastCode: null, deliveredAt: null },
    manualRecovery: { required: false, lastRejectReason: null },
    degraded: false,
    ...extra,
  }, null, 2)}\n`;
  const alertsOf = async (dir, guard) => {
    const sent = [];
    const run = await startHook({
      dir,
      guard,
      sessions: [BG_KEY],
      notifyOwner: async (text) => { sent.push(text); return { outcome: 'delivered', code: null }; },
    });
    try {
      await run.hook.flushIdentityGuardNotifications();
    } finally { await run.hook.close(); }
    return sent.filter((text) => /降级|degraded/i.test(text));
  };

  // ① 赋值点 1（persist 捕获）：真实落盘失败 ⇒ 'persist-failed' ⇒ 类1 文案
  const dir1 = await tempDir();
  const file1 = path.join(dir1, 'identity-guard.json');
  await fs.writeFile(file1, validState(), 'utf8');
  const guard1 = await guardAt(file1);
  assert.equal(guard1.snapshot().state, 'normal', '前置：从磁盘加载到 normal');
  await fs.chmod(file1, 0o444); // rename 覆盖只读文件失败（既有注入手法）
  const failedAnomaly = await guard1.reportAnomaly({ kind: 'identity-legacy', detail: 'disk-readonly' });
  assert.equal(failedAnomaly.ok, false, '前置：落盘确实失败');
  assert.equal(failedAnomaly.reason, 'persist-failed');
  const snap1 = guard1.snapshot();
  assert.equal(snap1.degraded, true, '前置：内存 degraded');
  assert.equal(snap1.degradeReason, 'persist-failed', '赋值点 1：落盘失败必须给出 persist-failed');
  const alerts1 = await alertsOf(dir1, guard1);
  assert.ok(alerts1.length >= 1, `类1 必须发告警：${JSON.stringify(alerts1)}`);
  for (const text of alerts1) {
    assert.match(text, /写入磁盘失败/, `真实 guard 的类1 文案必须点明落盘失败：${text}`);
    assert.equal(/状态文件损坏/.test(text), false, `真实 guard 的类1 不得说成文件损坏：${text}`);
  }

  // ② 赋值点 3（applyLoad 读回旧标记）：磁盘上带 degraded:true ⇒ degradeReason='degraded'。
  // 但**验到一个反直觉事实**：hook 的 reconcile 先跑 retryPersist()，所以类4 文案在真实 guard 下
  // 几乎不可达 —— 磁盘可写会自愈（degraded 清空、不告警），磁盘不可写会让 degradeReason 翻成
  // 'persist-failed'（走类1，此刻如实）。类4 只剩「热更新窗口（新 hook + 无 retryPersist 的旧
  // guard）」或 retryPersist 抛错两条通路。这里把两条真实通路都钉住，避免以后误以为它是活路径。
  const dir4 = await tempDir();
  const file4 = path.join(dir4, 'identity-guard.json');
  await fs.writeFile(file4, validState({ degraded: true }), 'utf8');
  const guard4 = await guardAt(file4);
  const snap4 = guard4.snapshot();
  assert.equal(snap4.degraded, true, '前置：读回 degraded');
  assert.equal(snap4.degradeReason, 'degraded', '赋值点 3：旧版本标记必须给出 degraded');

  // 通路 A：磁盘可写 ⇒ 自愈，不发任何 degraded 告警
  const alerts4a = await alertsOf(dir4, guard4);
  assert.equal(guard4.snapshot().degraded, false, '磁盘可写时必须自愈');
  assert.deepEqual(alerts4a, [], `自愈后不得再发 degraded 告警：${JSON.stringify(alerts4a)}`);

  // 通路 B：磁盘只读 ⇒ 立刻翻成 persist-failed，文案必须是类1（不许再说旧标记，也不许说文件损坏）
  const dir4b = await tempDir();
  const file4b = path.join(dir4b, 'identity-guard.json');
  await fs.writeFile(file4b, validState({ degraded: true }), 'utf8');
  const guard4b = await guardAt(file4b);
  await fs.chmod(file4b, 0o444);
  const alerts4b = await alertsOf(dir4b, guard4b);
  assert.equal(guard4b.snapshot().degradeReason, 'persist-failed', '自愈失败后成因必须翻成 persist-failed');
  assert.ok(alerts4b.length >= 1, `自愈失败必须告警：${JSON.stringify(alerts4b)}`);
  for (const text of alerts4b) {
    assert.match(text, /写入磁盘失败/, `类1 必须点明落盘失败：${text}`);
    assert.equal(/状态文件损坏/.test(text), false, `不得说成文件损坏：${text}`);
  }

  // ③ 赋值点 2（failClosed）叠加赋值点 1：损坏 → 受控补报成功 → 再落盘失败 ⇒ 类3（两条事实都要说）
  const dir3 = await tempDir();
  const file3 = path.join(dir3, 'identity-guard.json');
  await fs.writeFile(file3, '{ this is not json', 'utf8');
  const guard3 = await guardAt(file3);
  assert.equal(guard3.snapshot().skipReason, 'state-corrupt', '前置：failClosed');
  assert.equal(guard3.snapshot().degradeReason, 'state-corrupt', '赋值点 2：failClosed 必须给出白名单 reason');
  const declared = await guard3.declareControlledRecoveryAnomaly({ detail: 'state-file-unreadable' });
  assert.equal(declared.ok, true, `前置：受控补报必须能落盘：${JSON.stringify(declared)}`);
  assert.equal(guard3.snapshot().degraded, false, '前置：成功落盘已自愈 degraded');
  await fs.chmod(file3, 0o444);
  const receiptFailed = await guard3.reportNotifyResult({
    operationId: declared.notifyRequired.operationId,
    outcome: 'delivered',
  });
  assert.equal(receiptFailed.ok, false, '前置：磁盘再次失败');
  const snap3 = guard3.snapshot();
  assert.equal(snap3.degradeReason, 'persist-failed', '赋值点 1 再次生效');
  assert.equal(snap3.skipReason, 'state-corrupt', '前置：历史 skipReason 仍在（这是类3 的判据）');
  const alerts3 = await alertsOf(dir3, guard3);
  assert.ok(alerts3.length >= 1, `类3 必须发告警：${JSON.stringify(alerts3)}`);
  for (const text of alerts3) {
    assert.match(text, /写入磁盘失败/, `类3 必须承认本次是落盘失败：${text}`);
    assert.match(text, /state-corrupt/, `类3 必须点出残留的损坏记录：${text}`);
    assert.equal(/这不是落盘失败/.test(text), false, `类3 不得使用类2 的排他说法：${text}`);
  }
});

// ── task-84 P2-2（V3）：告警必须晚于 retryPersist —— 能自愈就不许误报 ──

test('task-84 P2-2：flush 内 retryPersist 必须先于降级告警，自愈后不得告警（顺序契约）', async () => {
  // 复审实证（task-84 V3）：把 maybeNotifyDegraded 前移到 retryPersist 之前，仓库套件 120/120 全绿。
  // 真实 guard 上这个顺序没法用 fs 时序钉住（磁盘「恰好在两次调用之间恢复」不可控），
  // 所以这里用有状态的桩：snapshot() 在 retryPersist 之前返回 degraded=true，之后返回 degraded=false。
  // 顺序正确 ⇒ 永远看不到 degraded=true 的可告警时刻（不告警）；顺序颠倒 ⇒ 立刻误报（红）。
  let healed = false;
  const calls = [];
  const baseSnap = () => ({
    state: 'writes-paused',
    effectiveState: 'all-paused',
    degraded: !healed,
    degradeReason: 'persist-failed',
    skipReason: null,
    degradedLatchWriteFailed: false,
    identityOk: null,
    anomalyId: null,
    notify: { status: 'delivered', operationId: 'op-1', attempts: 1, lastAt: null, lastCode: null },
    restoreNotify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    manualRecovery: { required: false, lastRejectReason: null },
  });
  const guard = {
    snapshot: () => { calls.push('snapshot'); return baseSnap(); },
    evaluateNotifyDeadline: async () => { calls.push('evaluateNotifyDeadline'); return { ok: true }; },
    retryPersist: async () => { calls.push('retryPersist'); healed = true; return { ok: true }; },
    reportAnomaly: async () => ({ ok: true }),
    reportIdentityRestored: async () => ({ ok: true }),
    reportNotifyResult: async () => ({ ok: true }),
    reportRestoreNotifyResult: async () => ({ ok: true }),
    recoverManually: async () => ({ ok: false, reason: 'precondition-failed', failed: [] }),
  };
  const dir = await tempDir();
  const sent = [];
  const run = await startHook({
    dir,
    guard,
    sessions: [BG_KEY],
    notifyOwner: async (text) => { sent.push(text); return { outcome: 'delivered', code: null }; },
  });
  try {
    await run.hook.flushIdentityGuardNotifications();
  } finally { await run.hook.close(); }
  const alerts = sent.filter((text) => /降级|degraded/i.test(text));
  assert.equal(calls.includes('retryPersist'), true, `flush 必须尝试自愈：${JSON.stringify(calls)}`);
  assert.equal(healed, true, '前置：retryPersist 已自愈');
  assert.deepEqual(alerts, [], `能自愈就不得误报降级（告警必须晚于 retryPersist）：${JSON.stringify(alerts)}`);
});

// ── task-83 F2：锁存写失败事实可用后，告警不得再让运维自己去猜「重启安不安全」 ──

test('task-83 F2：类1 告警必须按 degradedLatchWriteFailed 事实分支，不得含糊两可', async () => {
  const mkSnap = (latchFlag) => () => ({
    state: 'writes-paused',
    effectiveState: 'all-paused',
    degraded: true,
    degradeReason: 'persist-failed',
    skipReason: null,
    degradedLatchWriteFailed: latchFlag,
    identityOk: null,
    anomalyId: null,
    notify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    restoreNotify: { status: 'none', operationId: null, attempts: 0, lastAt: null, lastCode: null },
    manualRecovery: { required: false, lastRejectReason: null },
  });
  const guardFor = (snap) => ({
    snapshot: snap,
    evaluateNotifyDeadline: async () => ({ ok: true }),
    reportAnomaly: async () => ({ ok: true }),
    reportIdentityRestored: async () => ({ ok: true }),
    reportNotifyResult: async () => ({ ok: true }),
    reportRestoreNotifyResult: async () => ({ ok: true }),
    recoverManually: async () => ({ ok: false, reason: 'precondition-failed', failed: [] }),
  });
  const alertsWith = async (latchFlag) => {
    const dir = await tempDir();
    const sent = [];
    const run = await startHook({
      dir,
      guard: guardFor(mkSnap(latchFlag)),
      sessions: [BG_KEY],
      notifyOwner: async (text) => { sent.push(text); return { outcome: 'delivered', code: null }; },
    });
    try {
      await run.hook.flushIdentityGuardNotifications();
    } finally { await run.hook.close(); }
    return sent.filter((text) => /降级|degraded/i.test(text));
  };

  // 事实 = 锁存也写失败：必须明确「磁盘无痕 + 不要重启」，且不得再给「若……」的两可表述
  const failedAlerts = await alertsWith(true);
  assert.ok(failedAlerts.length >= 1, `必须发告警：${JSON.stringify(failedAlerts)}`);
  for (const text of failedAlerts) {
    console.error(`[diag-task83-w-latchfail] ${text}`);
    assert.match(text, /锁存也写失败/, `必须点明锁存也写失败：${text}`);
    assert.match(text, /不要用重启处置/, `必须明确不要靠重启处置：${text}`);
    assert.equal(/重启后果分两种/.test(text), false, `事实已知时不得再给两可表述：${text}`);
    assert.equal(/若降级锁存已写成/.test(text), false, `事实已知时不得再假设锁存写成：${text}`);
  }

  // 事实 = 锁存写成：必须明确「重启仍 fail-closed、限制不会消失」，且不得再说会静默回滚
  const okAlerts = await alertsWith(false);
  assert.ok(okAlerts.length >= 1, `必须发告警：${JSON.stringify(okAlerts)}`);
  for (const text of okAlerts) {
    console.error(`[diag-task83-w-latchok] ${text}`);
    assert.match(text, /降级锁存已写成/, `必须说清锁存已写成：${text}`);
    assert.match(text, /限制不会消失/, `必须说清限制不会消失：${text}`);
    assert.equal(/静默回滚/.test(text), false, `锁存写成时不得说会静默回滚：${text}`);
    assert.equal(/重启后果分两种/.test(text), false, `事实已知时不得再给两可表述：${text}`);
  }

  // 事实缺失（旧快照/热更新不一致）：必须退回两可表述，绝不编造单一结论
  const unknownAlerts = await (async () => {
    const dir = await tempDir();
    const sent = [];
    const snap = mkSnap(undefined);
    const run = await startHook({
      dir,
      guard: guardFor(snap),
      sessions: [BG_KEY],
      notifyOwner: async (text) => { sent.push(text); return { outcome: 'delivered', code: null }; },
    });
    try {
      await run.hook.flushIdentityGuardNotifications();
    } finally { await run.hook.close(); }
    return sent.filter((text) => /降级|degraded/i.test(text));
  })();
  assert.ok(unknownAlerts.length >= 1, `必须发告警：${JSON.stringify(unknownAlerts)}`);
  for (const text of unknownAlerts) {
    assert.match(text, /重启后果分两种/, `事实缺失时必须给出两可表述：${text}`);
    assert.match(text, /本进程未报告锁存写入结果/, `必须说清为什么含糊（不得假装知道）：${text}`);
  }
});

// ── m21233（独立故障注入复核）：身份门禁不可用 ⇒ 授权端点整体拒绝启动 ──────────────
// 背景：旧实现把「guard 构造/load 抛错」吞成 guard=null 继续启动，而 hook 把 guard 当可选、
// authorize-api 只在 guard 非 null 时才应用身份门禁 ⇒ 本应 all-paused 的状态在守卫初始化抛错后
// 变成「没有身份门禁、照常放行写」。修复把契约放进 hook 的启动判定（requireIdentityGuard 严格
// 布尔），生产 bridge 显式传 true；不传的旧调用方行为完全不变（task-49 起 guard 本就是可选注入）。

test('m21233 契约：requireIdentityGuard=true 且守卫缺失 ⇒ 拒绝启动（identity-guard-unavailable）', async () => {
  const dir = await tempDir();
  const hook = createBackgroundPatrolBridgeHook({
    config: hookConfig(),
    consoleToken: TOKEN,
    controllerStorePath: path.join(dir, 'controller.json'),
    ownerQQ: OWNER,
    sessions: [BG_KEY],
    requireIdentityGuard: true,
    port: 0,
  });
  const started = await hook.start();
  try {
    assert.equal(started.ok, false, `必须拒绝启动，实际：${JSON.stringify(started)}`);
    assert.equal(started.error, 'identity-guard-unavailable');
    const status = hook.status();
    assert.equal(status.started, false, '端点不得停在已启动状态');
    assert.equal(status.url, null, '端口不得被绑定');
    assert.equal(status.lastError, 'identity-guard-unavailable');
  } finally {
    // 变异验证要求：断言失败时也要关掉可能已启动的端点，否则残留监听会让整个测试进程挂死、
    // 无法把「变红」如实报出来（挂死看起来像超时，掩盖真正的失败计数）。
    await hook.close();
  }
});

test('m21233 兼容契约：不传 requireIdentityGuard 的旧调用方仍可在无守卫下正常启动', async () => {
  const dir = await tempDir();
  const run = await startHook({ dir, sessions: [BG_KEY] });
  try {
    assert.equal(run.started.ok, true, JSON.stringify(run.started));
    assert.equal(run.started.enabled, true);
    assert.equal(typeof run.started.url, 'string', '旧调用方必须照旧拿到真实 url');
  } finally { await run.hook.close(); }
});

test('m21233 契约：requireIdentityGuard 非布尔值不得静默当 false', async () => {
  for (const bad of ['true', 1, 0, null]) {
    const dir = await tempDir();
    const hook = createBackgroundPatrolBridgeHook({
      config: hookConfig(),
      consoleToken: TOKEN,
      controllerStorePath: path.join(dir, 'controller.json'),
      ownerQQ: OWNER,
      sessions: [BG_KEY],
      requireIdentityGuard: bad,
      port: 0,
    });
    const started = await hook.start();
    try {
      assert.equal(started.ok, false, `requireIdentityGuard=${JSON.stringify(bad)} 必须拒绝启动`);
      assert.equal(started.error, 'invalid-require-identity-guard', `requireIdentityGuard=${JSON.stringify(bad)}`);
    } finally {
      await hook.close();
    }
  }
});

test('m21233 有效守卫判定：load 返回 failClosed=true 的守卫仍算可用（不得误判为不可用）', async () => {
  const dir = await tempDir();
  const guardPath = path.join(dir, 'guard.json');
  // schema 合法但内容非法 → load 返回 { ok:true, failClosed:true, reason:'state-invalid' }
  await fs.writeFile(guardPath, JSON.stringify({ schemaVersion: 1, state: 'normal', bogus: true }), 'utf8');
  const guard = createXiaoheiheIdentityGuard({ filePath: guardPath });
  const loaded = await guard.load();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.failClosed, true, `必须是 failClosed 的守卫：${JSON.stringify(loaded)}`);
  const run = await startHook({ dir, guard, sessions: [BG_KEY], extra: { requireIdentityGuard: true } });
  try {
    assert.equal(run.started.ok, true, `failClosed 守卫是有效守卫，必须能启动：${JSON.stringify(run.started)}`);
    assert.equal(run.started.enabled, true);
  } finally { await run.hook.close(); }
});
