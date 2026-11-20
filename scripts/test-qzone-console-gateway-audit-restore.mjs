// M9 离线管理链 · `enableAuditFaultRestore` 从 runtime/gateway 到 router 的显式 opt-in 贯通。
//
// WHAT THIS FILE PINS, AND WHY EACH CASE EXISTS
// --------------------------------------------
// Before this change the flag existed on `createOfflineQzoneAdminRouter` but NOTHING passed it:
// `qzone-console-gateway.mjs` built the router without it and `qzone-console-runtime.mjs` built the
// gateway without it. So the switch was unreachable from the only authenticated entry point, and
// `/audit/fault/restore` was 404 for every real caller — the route existed but the chain was broken.
//
// These cases exercise the CHAIN, not the route in isolation (the route's own semantics are already
// pinned in `test-qzone-admin-router-offline.mjs` M10-1..M10-10):
//   CG-1  omitting the flag at the gateway keeps the default: 404, zero state change
//   CG-2  explicit enable + a real open gap ⇒ 200, gap marked, exactly one admin_console audit row
//   CG-3  explicit enable + a PROCESS LATCH only ⇒ 200, releasedLatch, latch gone
//         (this is the proof that the REAL handle — and therefore the real authority — is forwarded:
//          a closure double would carry no authority and M9 would refuse it)
//   CG-4  outer guard (authorizeConsole) refuses ⇒ 403, zero recovery, zero audit
//   CG-5  invalid session cookie ⇒ 401, zero recovery, zero audit
//   CG-6  CSRF refuses ⇒ 403, zero recovery, zero audit
//   CG-7  generation mismatch / latch-revision mismatch ⇒ 409 and the latch SURVIVES
//   CG-8  the flag never turns `dispatchAvailable` on
//   CG-9  non-boolean flag values are refused at the construction boundary
//
// All cases use a REAL temporary SQLite file and in-memory requests. No listener, no spawn, no
// production constructor.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { createQzoneConsoleGateway } from '../src/core/qzone-console-gateway.mjs';
import { latchFault, readFaultLatch } from '../src/core/qzone-write-path-offline.mjs';

const NOW = Date.parse('2026-11-08T03:00:00Z');
const PREFIX = '/api/console/qqspace-column';
const RESTORE_PATH = `${PREFIX}/audit/fault/restore`;
const GEN = 'g0123456789abcdef01234567';
const OTHER_GEN = 'gffffffffffffffffffffffff';
const PASSWORD = 'fixture-password-123456';

const clock = () => NOW;

/** A store state with everything the admin routes read (real shape, not a stub). */
const initialState = () => ({
  enabled: false, readAllowed: true, writeAllowed: true,
  accessPaused: false, writePaused: false, reads: 0, writes: 0, probe: 'done',
  tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
  limits: { post: 3, comment: 25, like: 30 }, intervalMinutes: 100, activeStart: 420, activeEnd: 1380,
  ledger: { day: '2026-11-08', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
  lastPostAt: null, commentTargets: [], likes: [], outcomes: {}, dispatchClaims: {}, notices: [],
  readAttempts: {}, readOutcomes: {}, botQq: '123456', selfId: '123456', audit: [],
});

/** A real, format-valid open gap (the shape M8 writes; `resolvedBy` absent = open). */
const openGap = (generation = GEN) => ({
  key: 'settle-1', reason: 'audit-write-failed', generation, time: NOW - 1000,
});

/**
 * Wire the real gateway over a real temp store and log in through the real session route, so the
 * cookie used below is a genuine `qqspace` session — not a stub that bypasses verification.
 */
async function chain(t, { enable, gaps = [], authorizeConsole, verifyCsrf, skipLogin = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-console-gateway-m9-'));
  const store = openOfflineStore(join(dir, 'state.db'), initialState());
  if (gaps.length) store.update((s) => ({ ...s, auditGaps: gaps }));
  t.after(async () => { try { store.close(); } catch { /* already closed */ } await rm(dir, { recursive: true, force: true }); });

  const gateway = createQzoneConsoleGateway({
    store, stateDir: dir, selfId: '123456', consoleToken: 'fixture-console-token',
    authorizeConsole: authorizeConsole ?? (() => true),
    verifyCsrf: verifyCsrf ?? (() => true),
    isAgentPaused: () => true, now: clock,
    // Omitted entirely when `enable` is undefined — that is exactly how the production callers build
    // it, so CG-1 measures the real default rather than a `false` we passed ourselves.
    ...(enable === undefined ? {} : { enableAuditFaultRestore: enable }),
  });

  let cookie = null;
  if (!skipLogin) {
    const setup = await gateway({ method: 'POST', pathname: `${PREFIX}/auth/setup`, headers: {}, body: { password: PASSWORD } });
    assert.equal(setup.status, 200, `前置：登录必须成功（实际 ${JSON.stringify(setup.body)}）`);
    cookie = setup.headers['set-cookie'].split(';')[0];
  }
  const post = (path, body, cookieOverride) => gateway({
    method: 'POST', pathname: path, headers: { cookie: cookieOverride ?? cookie }, ...(body === undefined ? {} : { body }),
  });
  return { dir, store, gateway, post, cookie };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// CG-1 默认关闭：不传选项 ⇒ router 404，且零改动
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('CG-1 gateway 不传 enableAuditFaultRestore ⇒ 默认关闭：路由 404 且零恢复零审计', async (t) => {
  const c = await chain(t, { gaps: [openGap()] });
  const before = JSON.stringify(c.store.read());

  const r = await c.post(RESTORE_PATH, { expectedGeneration: GEN });
  assert.equal(r.status, 404, '★★★ 未 opt-in 时该路由必须与「不存在」不可区分');
  assert.equal(r.body.error, 'not_found');
  assert.equal(JSON.stringify(c.store.read()), before, '★★★ 零改动：无恢复、无缺口标注、无审计行');

  // GET 同样 404：这是“没有这条路由”，不是“方法不对”。
  const g = await c.gateway({ method: 'GET', pathname: RESTORE_PATH, headers: { cookie: c.cookie } });
  assert.equal(g.status, 404, '★ 默认关闭时 GET 也是 404（不是 405）');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// CG-2 显式启用 + 合法 gap：200，缺口标 resolvedBy，恰一条 admin_console 审计
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('CG-2 显式启用 + 合法缺口 ⇒ 200：缺口被标注（不删除），恰一条 admin_console 恢复审计', async (t) => {
  const c = await chain(t, { enable: true, gaps: [openGap()] });
  const auditBefore = c.store.read().audit.length;

  const r = await c.post(RESTORE_PATH, { expectedGeneration: GEN });
  assert.equal(r.status, 200, `★★★ 合法恢复必须成功（实际 ${JSON.stringify(r.body)}）`);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.result, 'success');
  assert.equal(r.body.resolvedGapCount, 1);
  assert.equal(r.body.releasedLatch, false, '本次没有锁存，不得谎报已释放');

  const after = c.store.read();
  assert.equal(after.auditGaps.length, 1, '★★ 缺口条目保留（证据不删）');
  assert.notEqual(after.auditGaps[0].resolvedBy, null, '★★ 缺口被标注为已解决');
  assert.deepEqual({ ...after.auditGaps[0].resolvedBy },
    { generation: GEN, at: NOW, operator: after.audit.at(-1).record.operator },
    '★ 标记的 operator/at 来自受信上下文，不是请求体');

  assert.equal(after.audit.length, auditBefore + 1, '★★ 恰好新增一条审计');
  const row = after.audit.at(-1).record;
  assert.equal(row.source, 'admin_console', '★★ 来源是受控构造依赖（网关身份），不是请求体');
  assert.equal(row.result, 'success');
  assert.equal(row.action, 'restore');
  const content = JSON.parse(row.content);
  assert.equal(content.intent, 'restore_audit_fault', '★ 与「解除平台暂停」可区分');
  assert.equal(content.generation, GEN);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// CG-3 显式启用 + 纯锁存：200 + releasedLatch —— 真实 store 句柄（＝真实权威）的证明
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('CG-3 显式启用 + 纯锁存恢复 ⇒ 200 且 releasedLatch：证明网关传的是真实句柄而非闭包替身', async (t) => {
  const c = await chain(t, { enable: true });
  latchFault(c.store, 'console-chain-latch');
  const revision = readFaultLatch(c.store).revision;
  assert.ok(Number.isSafeInteger(revision), '前提：锁存已建立且有 revision');

  const r = await c.post(RESTORE_PATH, { expectedGeneration: GEN, expectedLatchRevision: revision });
  assert.equal(r.status, 200, `★★★ 纯锁存恢复必须成功（实际 ${JSON.stringify(r.body)}）`);
  assert.equal(r.body.releasedLatch, true, '★★ 锁存确实被释放');
  assert.equal(r.body.resolvedGapCount, 0, '★ 没有缺口可标');
  assert.equal(readFaultLatch(c.store), null,
    '★★★ 按同一 authority 清除成功 —— 若网关传的是 {read,update} 闭包替身，M9 的 requireAuthority 会直接抛，'
    + '这条用例会变成 500 而不是 200');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// CG-4/5/6 三层拒绝：零恢复、零审计
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('CG-4 外层 authorizeConsole 拒绝 ⇒ 403，零恢复零审计（且路由是否存在都不泄露）', async (t) => {
  const c = await chain(t, { enable: true, gaps: [openGap()], authorizeConsole: () => false, skipLogin: true });
  const before = JSON.stringify(c.store.read());
  const r = await c.post(RESTORE_PATH, { expectedGeneration: GEN }, 'anything');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'console-auth-required');
  assert.equal(JSON.stringify(c.store.read()), before, '★★★ 零恢复、零审计');
});

test('CG-5 session 校验拒绝（伪造 cookie）⇒ 401，零恢复零审计', async (t) => {
  const c = await chain(t, { enable: true, gaps: [openGap()] });
  const before = JSON.stringify(c.store.read());
  const r = await c.post(RESTORE_PATH, { expectedGeneration: GEN }, 'qqspace_column_session=forged-session-value');
  assert.equal(r.status, 401, '★★★ 网关会话校验必须仍然生效（不得被这个开关改松）');
  assert.equal(r.body.error, 'unauthorized');
  assert.equal(JSON.stringify(c.store.read()), before, '★★★ 零恢复、零审计');
});

test('CG-6 CSRF 拒绝 ⇒ 403，零恢复零审计', async (t) => {
  const c = await chain(t, { enable: true, gaps: [openGap()], verifyCsrf: () => false, skipLogin: true });
  const before = JSON.stringify(c.store.read());
  const r = await c.post(RESTORE_PATH, { expectedGeneration: GEN }, 'any');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'csrf-required');
  assert.equal(JSON.stringify(c.store.read()), before, '★★★ 零恢复、零审计');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// CG-7 业务拒绝（代际 / revision）⇒ 409，且锁存保留
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('CG-7 代际不符 ⇒ 409 且故障保持；latch revision 不符同样 409 且锁存保留', async (t) => {
  const c = await chain(t, { enable: true, gaps: [openGap()] });

  const mismatch = await c.post(RESTORE_PATH, { expectedGeneration: OTHER_GEN });
  assert.equal(mismatch.status, 409, '★★★ 代际不符是业务拒绝，不是 200');
  assert.equal(mismatch.body.ok, false);
  assert.equal(mismatch.body.error, 'recovery_refused');
  assert.equal(mismatch.body.reason, 'generation-mismatch');
  const afterMismatch = c.store.read();
  // ABSENT and `null` both mean "still open" (that is the gate's own reading); a gap written without
  // the field must not be mistaken for a resolved one here either.
  assert.equal(afterMismatch.auditGaps[0].resolvedBy ?? null, null, '★★★ 缺口必须保持打开');
  assert.equal(afterMismatch.audit.at(-1).record.result, 'denied', '★ 拒绝留痕（不是静默）');

  // Revision mismatch: the latch exists but the operator named the wrong revision.
  latchFault(c.store, 'revision-guard');
  const wrong = await c.post(RESTORE_PATH, { expectedGeneration: GEN, expectedLatchRevision: 999 });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.reason, 'latch-revision-mismatch');
  assert.notEqual(readFaultLatch(c.store), null, '★★★ 乐观锁不符时锁存必须保留');
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// CG-8/9 dispatchAvailable 与构造边界
// ══════════════════════════════════════════════════════════════════════════════════════════════
test('CG-8 打开该选项不得让 dispatchAvailable 变 true', async (t) => {
  const c = await chain(t, { enable: true });
  const r = await c.gateway({ method: 'GET', pathname: `${PREFIX}/status`, headers: { cookie: c.cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.body.dispatchAvailable, false,
    '★★ 恢复开关只加管理路由，不表示派发能力已接线');
});

test('CG-9 构造边界拒绝非布尔：gateway 与 runtime 都抛 TypeError（不静默 coerce）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-console-gateway-m9-bool-'));
  const store = openOfflineStore(join(dir, 'state.db'), initialState());
  t.after(async () => { try { store.close(); } catch { /* closed */ } await rm(dir, { recursive: true, force: true }); });

  const base = { store, stateDir: dir, selfId: '123456', consoleToken: 'fixture-console-token',
    authorizeConsole: () => true, verifyCsrf: () => true, isAgentPaused: () => true, now: clock };
  for (const bad of ['true', 1, 0, null, {}, []]) {
    assert.throws(() => createQzoneConsoleGateway({ ...base, enableAuditFaultRestore: bad }),
      /invalid enableAuditFaultRestore/, `★ gateway: ${JSON.stringify(bad)} 不是合法开关值`);
  }
  // The runtime refuses at its own boundary too (before any store is opened).
  const { openQzoneConsoleRuntime } = await import('../src/core/qzone-console-runtime.mjs');
  for (const bad of ['true', 1, null]) {
    await assert.rejects(openQzoneConsoleRuntime({ stateDir: dir, consoleToken: 'fixture-console-token',
      getIdentity: async () => '123456', authorizeConsole: () => true, verifyCsrf: () => true,
      isAgentPaused: () => true, now: clock, enableAuditFaultRestore: bad }),
    /invalid enableAuditFaultRestore/, `★ runtime: ${JSON.stringify(bad)} 不是合法开关值`);
  }
});
