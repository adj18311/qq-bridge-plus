import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openQzoneConsoleRuntime, applyCleanupOutcome, interpretDatabaseReport, interpretFilesReport,
  cleanupInterpreters,
} from '../src/core/qzone-console-runtime.mjs';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { beijingDay } from '../src/core/qzone-policy-offline.mjs';

test('首次初始化必须确认账号，默认关闭；重启后离线仍可访问原账号的配置', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-')); let runtime;
  t.after(async () => { runtime?.close(); await rm(dir, { recursive: true, force: true }); });
  const config = { stateDir: dir, consoleToken: 'fixture-console', getIdentity: async () => '123',
    authorizeConsole: () => true, verifyCsrf: () => true, isAgentPaused: () => true,
    now: () => Date.parse('2026-11-08T03:00:00Z') };
  runtime = await openQzoneConsoleRuntime(config);
  assert.equal(runtime.selfId, '123');
  const initialView = openOfflineStore(join(dir, 'qzone-console-state.sqlite'), {});
  try {
    const state = initialView.read();
    assert.equal(state.selfId, '123');
    assert.deepEqual(state.outcomes, {});
    assert.deepEqual(state.dispatchClaims, {});
    assert.deepEqual(state.readAttempts, {});
    assert.deepEqual(state.notices, []);
    assert.deepEqual(state.pauseCycles, { access: null, write: null });
    assert.deepEqual(state.likes, []);
    assert.equal(state.lastPostAt, null);
  } finally { initialView.close(); }
  const setup = await runtime.handle({ method: 'POST', pathname: '/api/console/qqspace-column/auth/setup', headers: {}, body: { password: 'test-password-123' } });
  const cookie = setup.headers['set-cookie'].split(';')[0];
  const status = await runtime.handle({ method: 'GET', pathname: '/api/console/qqspace-column/status', headers: { cookie } });
  assert.equal(status.status, 200);
  assert.equal(status.body.enabled, false);
  runtime.close();
  await assert.rejects(openQzoneConsoleRuntime({ ...config, getIdentity: async () => '456' }), /identity-mismatch/);
  runtime = await openQzoneConsoleRuntime({ ...config, getIdentity: async () => { throw new Error('offline'); } });
  assert.equal(runtime.selfId, '123');
});

test('首次无法确认账号时拒绝创建，不能接受伪造的无效身份', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  for (const id of [null, '', 'not-an-id']) {
    await assert.rejects(openQzoneConsoleRuntime({ stateDir: dir, consoleToken: 'fixture-console', getIdentity: async () => id,
      authorizeConsole: () => true, verifyCsrf: () => true, isAgentPaused: () => true }));
  }
});

test('现有状态库为符号链接时拒绝打开，避免清理指向其他目标的数据', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-link-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const target = join(dir, 'other.sqlite');
  const db = openOfflineStore(target, { botQq: '123', audit: [] }); db.close();
  try { await symlink(target, join(dir, 'qzone-console-state.sqlite'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('系统不允许创建测试符号链接'); return; } throw error; }
  await assert.rejects(openQzoneConsoleRuntime({ stateDir: dir, consoleToken: 'fixture-console', getIdentity: async () => '123',
    authorizeConsole: () => true, verifyCsrf: () => true, isAgentPaused: () => true }));
});

test('启动与北京时间零点仅清理过期审计，保留额度和暂停', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-prune-')); let runtime; let scheduled;
  t.after(async () => { runtime?.close(); await rm(dir, { recursive: true, force: true }); });
  let now = Date.parse('2026-11-08T03:00:00Z');
  const db = openOfflineStore(join(dir, 'qzone-console-state.sqlite'), { botQq: '123', enabled: false,
    readAllowed: true, writeAllowed: true, accessPaused: true, writePaused: true, reads: 3, writes: 3, probe: 'manual_only',
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 }, intervalMinutes: 100, activeStart: 420, activeEnd: 1380,
    ledger: { day: '2026-11-08', used: { post: 2, comment: 8, like: 9 }, reservations: {} },
    audit: [{ id: 'old', record: { time: now - 8 * 86400000 } }, { id: 'new', record: { time: now } }] });
  db.close();
  runtime = await openQzoneConsoleRuntime({ stateDir: dir, consoleToken: 'fixture-console', getIdentity: async () => '123',
    authorizeConsole: () => true, verifyCsrf: () => true, isAgentPaused: () => true, now: () => now,
    schedule: (fn, delay) => { scheduled = { fn, delay }; return { unref() {} }; }, cancelSchedule: () => {} });
  const view = openOfflineStore(join(dir, 'qzone-console-state.sqlite'), {});
  try {
    assert.deepEqual(view.read().audit.map((x) => x.id), ['new']);
    assert.equal(view.read().accessPaused, true);
    assert.equal(view.read().pauseCycles, undefined, '旧状态不能凭空编造暂停周期');
    assert.deepEqual(view.read().ledger.used, { post: 2, comment: 8, like: 9 });
    assert.equal(scheduled.delay, 13 * 3600000);
    view.update((state) => ({ ...state, audit: [...state.audit, { id: 'soon-expired', record: { time: now - 6 * 86400000 } }] }));
    now += scheduled.delay;
    scheduled.fn();
    assert.deepEqual(view.read().audit.map((x) => x.id), ['new']);
    assert.equal(view.read().writePaused, true);
    assert.deepEqual(view.read().ledger.used, { post: 2, comment: 8, like: 9 });
  } finally { view.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 任务卡 §7「启动时和每天零点清理过期审计文件」—— 文件侧的装配
//
// 背景（已核）：在这批改动之前，`createAuditJsonl().prune()` 在 `src/` 与 `plugins/` 下
// **0 个调用方**。启动/日切只调了 `pruneOfflineAudit`（store 侧）。任务卡要求两个存储各自清理，
// 所以补的是**装配**，不是新策略：删除规则仍是 `auditRetentionDecision`。
//
// 默认不启用：不传 `auditJsonlDir` 的调用方（含 src/bridge.js）行为一字未变。
// ══════════════════════════════════════════════════════════════════════════════════════════

/** 本文件新增用例用的固定"现在"。既有用例各自在内部定义了局部时间，不动它们。 */
const NOW = Date.parse('2026-11-08T03:00:00Z');

/** 造两个日文件：一个 8 天前（过期）、一个今天（保留）。返回它们的文件名。 */
function seedAuditFiles(root, now) {
  fs.mkdirSync(root, { recursive: true });
  const mk = (time, content) => {
    const name = `${beijingDay(time)}.jsonl`;
    fs.writeFileSync(join(root, name), JSON.stringify({
      time, source: 'qq', action: 'publish', target: '9876543210',
      postId: null, commentId: null, content, redacted: false,
      result: 'success', reason: '', quota: null,
    }) + '\n', 'utf8');
    return name;
  };
  return {
    oldName: mk(now - 8 * 86400000, 'old'),
    newName: mk(now, 'new'),
    root,
  };
}

const pruneConfig = (stateDir, extraOpts = {}) => ({
  stateDir, consoleToken: 'fixture-console', getIdentity: async () => '123',
  authorizeConsole: () => true, verifyCsrf: () => true, isAgentPaused: () => true,
  now: () => NOW, schedule: () => ({ unref() {} }), cancelSchedule: () => {}, ...extraOpts,
});

test('不给 auditJsonlDir 时不清理任何审计文件（默认激活与既有调用方一字未变）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-jsonl-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const stateDir = join(dir, 'state');
  const auditRoot = join(dir, 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  const { oldName, newName } = seedAuditFiles(auditRoot, NOW);

  // ⚠️ THE BAIT. A first version of this test only checked `auditRoot`, which is NOT where a
  // "guess a default directory" implementation would look — so a mutant that defaulted to
  // `join(stateDir, 'qzone-audit')` deleted nothing there and the test stayed green. Measured: M1
  // (default the option to a stateDir subdirectory) passed 9/9. The bait is an expired file placed
  // exactly where such a default would land, so guessing is now observable.
  const baitRoot = join(stateDir, 'qzone-audit');
  const bait = seedAuditFiles(baitRoot, NOW);

  const runtime = await openQzoneConsoleRuntime(pruneConfig(stateDir));
  try {
    assert.equal(fs.existsSync(join(auditRoot, oldName)), true,
      '★★★ 没传 auditJsonlDir 就绝不能删文件：默认激活必须不变');
    assert.equal(fs.existsSync(join(auditRoot, newName)), true);
    assert.equal(fs.existsSync(join(baitRoot, bait.oldName)), true,
      '★★★ 不得凭 stateDir 猜出目录去删：没传参数就一个文件都不碰');
  } finally { runtime.close(); }
});

test('给了 auditJsonlDir 时启动清理只删过期的日文件，保留在窗口内的', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-jsonl-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const stateDir = join(dir, 'state');
  const auditRoot = join(dir, 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  const { oldName, newName } = seedAuditFiles(auditRoot, NOW);

  const runtime = await openQzoneConsoleRuntime(pruneConfig(stateDir, { auditJsonlDir: auditRoot }));
  try {
    assert.equal(fs.existsSync(join(auditRoot, oldName)), false, '★★ 过期文件被删');
    assert.equal(fs.existsSync(join(auditRoot, newName)), true, '★★ 未过期文件保留');
  } finally { runtime.close(); }
});

test('auditJsonlDir 必须是绝对路径：相对路径直接拒绝（不猜 CWD）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-jsonl-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const stateDir = join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  for (const bad of ['state/qzone-audit', '', 123, null]) {
    if (bad === null) continue;   // null 与 undefined 同义地"未提供"，另有测试覆盖
    await assert.rejects(
      openQzoneConsoleRuntime(pruneConfig(stateDir, { auditJsonlDir: bad })),
      /auditJsonlDir must be an absolute path/,
      `★★ ${JSON.stringify(bad)} 必须被拒绝`,
    );
  }
});

test('日切回调同时清理文件侧（不是只清 store 侧）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-jsonl-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const stateDir = join(dir, 'state');
  const auditRoot = join(dir, 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  seedAuditFiles(auditRoot, NOW);

  let scheduled = null;
  let clock = NOW;
  const runtime = await openQzoneConsoleRuntime({
    ...pruneConfig(stateDir, { auditJsonlDir: auditRoot }),
    now: () => clock,
    schedule: (fn, delay) => { scheduled = { fn, delay }; return { unref() {} }; },
  });
  try {
    // 放一个"现在还没过期、越过两天后就过期"的文件
    const soonTime = NOW - 6 * 86400000;
    const soonName = `${beijingDay(soonTime)}.jsonl`;
    fs.writeFileSync(join(auditRoot, soonName), '{}\n', 'utf8');
    assert.equal(fs.existsSync(join(auditRoot, soonName)), true, '前提：日切前还在');

    clock = NOW + scheduled.delay + 2 * 86400000;
    scheduled.fn();

    assert.equal(fs.existsSync(join(auditRoot, soonName)), false,
      '★★★ 日切必须也清文件侧：若这条红，说明只装了 store 侧清理');
  } finally { runtime.close(); }
});

test('两个存储各清各的：删文件不动 store 行，删 store 行不动文件', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-jsonl-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const stateDir = join(dir, 'state');
  const auditRoot = join(dir, 'audit');
  fs.mkdirSync(stateDir, { recursive: true });

  // store 侧：一条过期、一条今天
  const dbPath = join(stateDir, 'qzone-console-state.sqlite');
  const seed = openOfflineStore(dbPath, {
    botQq: '123', selfId: '123', enabled: false, readAllowed: true, writeAllowed: true,
    accessPaused: true, writePaused: true, reads: 3, writes: 3, probe: 'manual_only',
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 }, intervalMinutes: 100, activeStart: 420, activeEnd: 1380,
    ledger: { day: '2026-11-08', used: { post: 2, comment: 8, like: 9 }, reservations: {} },
    audit: [
      { id: 'old', record: { time: NOW - 8 * 86400000 } },
      { id: 'new', record: { time: NOW } },
    ],
  });
  seed.close();

  // 文件侧：同样的过期/未过期布局
  const { oldName, newName } = seedAuditFiles(auditRoot, NOW);

  const runtime = await openQzoneConsoleRuntime(pruneConfig(stateDir, { auditJsonlDir: auditRoot }));
  const view = openOfflineStore(dbPath, {});
  try {
    assert.deepEqual(view.read().audit.map((x) => x.id), ['new'],
      '★ store 侧按 pruneOfflineAudit 删过期的 audit 行');
    assert.equal(fs.existsSync(join(auditRoot, oldName)), false, '★ 文件侧也删过期文件');
    assert.equal(fs.existsSync(join(auditRoot, newName)), true, '★ 文件侧保留未过期文件');
    // 关键：两个动作互不替代 —— 删文件不会让 store 行消失，反之亦然。
    assert.equal(view.read().audit.length, 1, '★★ store 行数与文件数无关，各清各的');
  } finally { view.close(); runtime.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// M9 opt-in 贯通：runtime → gateway → router
//
// WHY THESE CASES EXIST: the flag already existed on `createOfflineQzoneAdminRouter` but NOTHING
// passed it — the gateway built the router without it and this runtime built the gateway without it,
// so `/audit/fault/restore` was 404 for every real caller. The gateway→router hop is pinned in
// `test-qzone-console-gateway-audit-restore.mjs` (CG-1..CG-9); the cases below pin the
// runtime→gateway hop, i.e. that omitting the option keeps the whole chain closed and passing it
// opens exactly one route.
//
// Real temp SQLite + in-memory requests throughout: no listener, no spawn.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const M9_PREFIX = '/api/console/qqspace-column';
const M9_RESTORE = `${M9_PREFIX}/audit/fault/restore`;
const M9_GEN = 'g0123456789abcdef01234567';
const M9_OTHER_GEN = 'gffffffffffffffffffffffff';

/** Seed the runtime's sqlite file with a full state (optionally carrying open audit gaps). */
function seedRuntimeState(stateDir, { gaps = [] } = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const db = openOfflineStore(join(stateDir, 'qzone-console-state.sqlite'), {
    botQq: '123', selfId: '123', enabled: false, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, pauseCycles: { access: null, write: null },
    reads: 0, writes: 0, probe: 'done',
    tools: { read_posts: true, read_comments: true, publish: true, comment: true, reply: true, like: true },
    limits: { post: 3, comment: 25, like: 30 }, intervalMinutes: 100, activeStart: 420, activeEnd: 1380,
    ledger: { day: '2026-11-08', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    lastPostAt: null, commentTargets: [], likes: [], outcomes: {}, dispatchClaims: {}, notices: [],
    readAttempts: {}, readOutcomes: {}, browseDay: '2026-11-08', todayBrowses: 0,
    lastBrowseAt: null, usedOpportunities: {}, audit: [],
    ...(gaps.length ? { auditGaps: gaps } : {}),
  });
  db.close();
}

/** Log in through the real session route and return the cookie + a POST helper over the runtime. */
async function loginRuntime(runtime) {
  const setup = await runtime.handle({ method: 'POST', pathname: `${M9_PREFIX}/auth/setup`,
    headers: {}, body: { password: 'runtime-password-123456' } });
  assert.equal(setup.status, 200, `前置：登录必须成功（实际 ${JSON.stringify(setup.body)}）`);
  const cookie = setup.headers['set-cookie'].split(';')[0];
  return {
    cookie,
    post: (path, body) => runtime.handle({ method: 'POST', pathname: path, headers: { cookie }, body }),
    get: (path) => runtime.handle({ method: 'GET', pathname: path, headers: { cookie } }),
  };
}

test('M9-RT-1 runtime 不传 enableAuditFaultRestore ⇒ 整条链默认关闭：404 且零改动', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-m9-'));
  let runtime;
  t.after(async () => { runtime?.close(); await rm(dir, { recursive: true, force: true }); });
  const stateDir = join(dir, 'state');
  seedRuntimeState(stateDir, { gaps: [{ key: 'settle-1', reason: 'audit-write-failed', generation: M9_GEN, time: NOW - 1000 }] });

  runtime = await openQzoneConsoleRuntime(pruneConfig(stateDir));   // ← 不传开关
  const view = openOfflineStore(join(stateDir, 'qzone-console-state.sqlite'), {});
  try {
    const session = await loginRuntime(runtime);
    const before = JSON.stringify(view.read());
    const r = await session.post(M9_RESTORE, { expectedGeneration: M9_GEN });
    assert.equal(r.status, 404, '★★★ 生产构造方不传 ⇒ 路由必须不存在（行为与改动前逐字等价）');
    assert.equal(r.body.error, 'not_found');
    assert.equal(JSON.stringify(view.read()), before, '★★★ 零恢复、零审计、零缺口标注');
  } finally { view.close(); }
});

test('M9-RT-2 runtime 传 enableAuditFaultRestore: true ⇒ 合法缺口恢复成功且审计来源为 admin_console', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-m9-'));
  let runtime;
  t.after(async () => { runtime?.close(); await rm(dir, { recursive: true, force: true }); });
  const stateDir = join(dir, 'state');
  seedRuntimeState(stateDir, { gaps: [{ key: 'settle-1', reason: 'audit-write-failed', generation: M9_GEN, time: NOW - 1000 }] });

  runtime = await openQzoneConsoleRuntime(pruneConfig(stateDir, { enableAuditFaultRestore: true }));
  const view = openOfflineStore(join(stateDir, 'qzone-console-state.sqlite'), {});
  try {
    const session = await loginRuntime(runtime);
    const r = await session.post(M9_RESTORE, { expectedGeneration: M9_GEN });
    assert.equal(r.status, 200, `★★★ 开关贯通后必须可达（实际 ${JSON.stringify(r.body)}）`);
    assert.equal(r.body.result, 'success');
    assert.equal(r.body.resolvedGapCount, 1);

    const after = view.read();
    assert.notEqual(after.auditGaps[0].resolvedBy ?? null, null, '★★ 缺口被标注（不删除）');
    const row = after.audit.at(-1).record;
    assert.equal(row.source, 'admin_console');
    assert.equal(row.result, 'success');
  } finally { view.close(); }
});

test('M9-RT-3 runtime 链路上的纯锁存恢复：releasedLatch 为真（真实句柄一路传到底）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-m9-'));
  let runtime;
  let alias;
  t.after(async () => { alias?.close(); runtime?.close(); await rm(dir, { recursive: true, force: true }); });
  const stateDir = join(dir, 'state');
  seedRuntimeState(stateDir);

  runtime = await openQzoneConsoleRuntime(pruneConfig(stateDir, { enableAuditFaultRestore: true }));
  const { latchFault, readFaultLatch } = await import('../src/core/qzone-write-path-offline.mjs');

  // The runtime keeps its store private (only `handle`/`selfId`/`close` are exposed), so the latch is
  // raised through a SECOND handle on the SAME file. That is F-M4-1's shape, and it is the strongest
  // available proof that the runtime forwarded a REAL handle rather than a closure double: the
  // authority is minted from the canonical file, so both handles — and therefore the recovery route —
  // resolve to the same one. If the chain passed `{read, update}`, M9's `requireAuthority` would throw
  // and this case would see 500, not 200.
  alias = openOfflineStore(join(stateDir, 'qzone-console-state.sqlite'), {});
  latchFault(alias, 'runtime-chain-latch');
  const revision = readFaultLatch(alias).revision;
  assert.ok(Number.isSafeInteger(revision), '前提：锁存已建立且有 revision');

  const session = await loginRuntime(runtime);
  const r = await session.post(M9_RESTORE, { expectedGeneration: M9_GEN, expectedLatchRevision: revision });
  assert.equal(r.status, 200, `★★★ 纯锁存恢复必须成功（实际 ${JSON.stringify(r.body)}）`);
  assert.equal(r.body.releasedLatch, true, '★★ 锁存确实被释放');
  assert.equal(r.body.resolvedGapCount, 0, '★ 没有缺口可标');
  assert.equal(readFaultLatch(alias), null,
    '★★★ 同文件另一句柄上看到的锁存已被清除 ⇒ 整条链用的是同一 authority（真实 store 句柄）');
});

test('M9-RT-4 打开恢复开关不得让 dispatchAvailable 变 true', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-m9-'));
  let runtime;
  t.after(async () => { runtime?.close(); await rm(dir, { recursive: true, force: true }); });
  const stateDir = join(dir, 'state');
  seedRuntimeState(stateDir);

  runtime = await openQzoneConsoleRuntime(pruneConfig(stateDir, { enableAuditFaultRestore: true }));
  const session = await loginRuntime(runtime);
  const r = await session.get(`${M9_PREFIX}/status`);
  assert.equal(r.status, 200);
  assert.equal(r.body.dispatchAvailable, false, '★★ 恢复路由与派发能力无关');
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// AUDIT-CLEANUP VISIBILITY · process-local, read-only status
//
// MEASURED BASELINE before this change (real temp SQLite, importing this module):
//   · database side, `state.audit` not an array -> runtime CONSTRUCTION THREW; the only signal was
//     an exception message, and nothing recorded that cleanup had failed
//   · files side, unusable directory           -> swallowed entirely; zero observable trace
//   · `schedule()` throwing                    -> construction THREW
//   · a healthy runtime exposed exactly ['close','handle','selfId'] — no status at all
// So "did cleanup fail, and on which side?" was unanswerable. These cases pin the answer
// (numbering corrected in t37 — the earlier table was off by one from RT-CL-6 onward):
//   RT-CL-1 both sides ok
//   RT-CL-2 database failure visible (and startup still succeeds)
//   RT-CL-3 files failure visible (and the database side is not dragged down)
//   RT-CL-4 failure -> success keeps/updates lastSuccessAt and clears the stale code
//   RT-CL-5 a later failure does not erase the last real success time
//   RT-CL-6 the two sides are independent (both directions)
//   RT-CL-7 disabled files touch nothing + reading the status has no side effects
//   RT-CL-8 a stopped day-cut is reported as stopped, not "scheduled"
//
// The status is PROCESS-LOCAL (module-instance memory): nothing is written to the store and nothing
// is persisted, so a restart starts from `idle`/`disabled` again. It adds no timer, no retry and no
// alert channel; failures still never abort startup or the day-cut.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const CL_DAY = 86400000;

/** Overwrite the runtime's sqlite state in place (used to inject / repair a fault out of band). */
function rewriteRuntimeState(stateDir, mutate) {
  const db = openOfflineStore(join(stateDir, 'qzone-console-state.sqlite'), {});
  try { db.update(mutate); } finally { db.close(); }
}

/** The closed error-code vocabulary this module is allowed to expose (no messages, no paths). */
const CLOSED_CODES = new Set([
  'audit-state-invalid', 'store-update-failed', 'permission-denied', 'not-a-directory', 'busy',
  'no-space', 'read-only-filesystem', 'io-error', 'unexpected-report', 'unexpected',
  'clock-invalid', 'schedule-threw', 'closed',
]);

/** Nothing in the status may be a message, a stack, a path or an audit body. */
function assertNoLeak(status, label) {
  const text = JSON.stringify(status);
  for (const forbidden of ['\\', '/', 'Error', 'stack', 'message', 'qzone-console-state', 'STATE_SECRET']) {
    assert.equal(text.includes(forbidden), false, `${label}: 状态不得包含 ${forbidden}`);
  }
  for (const side of ['database', 'files']) {
    const code = status[side].code;
    if (code !== undefined) assert.ok(CLOSED_CODES.has(code), `${label}: ${side}.code 必须取自闭集（实际 ${code}）`);
  }
  if (status.schedule.code !== undefined) {
    assert.ok(CLOSED_CODES.has(status.schedule.code), `${label}: schedule.code 必须取自闭集`);
  }
}

test('RT-CL-1 两侧成功 ⇒ 双 ok 且 lastSuccessAt 有值', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-cleanup-'));
  const stateDir = join(dir, 'state');
  const auditRoot = join(dir, 'audit');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  seedRuntimeState(stateDir);
  rewriteRuntimeState(stateDir, (s) => ({
    ...s, audit: [{ id: 'old', record: { time: NOW - 8 * CL_DAY } }, { id: 'keep', record: { time: NOW } }],
  }));
  fs.mkdirSync(auditRoot, { recursive: true });
  fs.writeFileSync(join(auditRoot, '2019-01-01.jsonl'), '{}\n', 'utf8');

  const runtime = await openQzoneConsoleRuntime(pruneConfig(stateDir, { auditJsonlDir: auditRoot }));
  try {
    const status = runtime.auditCleanupStatus();
    assert.equal(status.database.state, 'ok', '★★ 数据库侧成功');
    assert.equal(status.files.state, 'ok', '★★ 文件侧成功');
    assert.equal(status.database.lastSuccessAt, NOW, '★ lastSuccessAt 是本次成功的时间');
    assert.equal(status.files.lastSuccessAt, NOW);
    assert.equal(status.database.lastRemoved, 1, '★ 删了 1 条过期审计行（读的是返回值）');
    assert.equal(status.files.lastRemoved, 1, '★ 删了 1 个过期日文件（读的是返回值）');
    assert.equal(status.schedule.state, 'scheduled', '★ 日切已安排');
    assertNoLeak(status, 'RT-CL-1');
  } finally { runtime.close(); }
});

test('RT-CL-2 数据库侧失败可见（闭集 code）且不阻断启动', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-cleanup-'));
  const stateDir = join(dir, 'state');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  seedRuntimeState(stateDir);
  rewriteRuntimeState(stateDir, (s) => ({ ...s, audit: 'CORRUPT-AUDIT' }));

  // THE BASELINE THIS REPLACES: this construction used to REJECT with `invalid audit state`.
  const runtime = await openQzoneConsoleRuntime(pruneConfig(stateDir));
  try {
    const status = runtime.auditCleanupStatus();
    assert.equal(status.database.state, 'failed', '★★★ 数据库侧失败必须可见');
    assert.equal(status.database.code, 'audit-state-invalid',
      '★★ code 必须指出“审计数组不可用”，而不是笼统的 io-error');
    assert.equal(status.database.lastSuccessAt, undefined, '★ 从未成功过 ⇒ 不得编造成功时间');
    assert.ok(Number.isFinite(status.database.lastAttemptAt), '★ 失败也要记下尝试时间');
    assert.equal(status.files.state, 'disabled', '★ 未配置文件侧 ⇒ disabled');
    assert.equal(status.schedule.state, 'scheduled', '★ 清理失败不阻断启动（日切照常安排）');
    assertNoLeak(status, 'RT-CL-2');
  } finally { runtime.close(); }
});

test('RT-CL-3 文件侧失败可见（闭集 code）且不影响数据库侧', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-cleanup-'));
  const stateDir = join(dir, 'state');
  const notADir = join(dir, 'audit-root');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  seedRuntimeState(stateDir);
  fs.writeFileSync(notADir, 'not a directory', 'utf8');

  const runtime = await openQzoneConsoleRuntime(pruneConfig(stateDir, { auditJsonlDir: notADir }));
  try {
    const status = runtime.auditCleanupStatus();
    assert.equal(status.files.state, 'failed', '★★★ 文件侧失败必须可见（旧实现完全吞掉）');
    assert.equal(status.files.code, 'not-a-directory', '★★ code 指出路径不是目录');
    assert.equal(status.database.state, 'ok', '★ 另一侧不受牵连');
    assertNoLeak(status, 'RT-CL-3');
  } finally { runtime.close(); }
});

test('RT-CL-4 失败后恢复成功 ⇒ 变 ok，lastSuccessAt 更新且旧失败码被清除', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-cleanup-'));
  const stateDir = join(dir, 'state');
  const notADir = join(dir, 'audit-root');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  seedRuntimeState(stateDir);
  rewriteRuntimeState(stateDir, (s) => ({ ...s, audit: 'CORRUPT-AUDIT' }));
  fs.writeFileSync(notADir, 'not a directory', 'utf8');

  let scheduled = null;
  let clock = NOW;
  const runtime = await openQzoneConsoleRuntime({
    ...pruneConfig(stateDir, { auditJsonlDir: notADir }),
    now: () => clock,
    schedule: (fn, delay) => { scheduled = { fn, delay }; return { unref() {} }; },
  });
  try {
    const failed = runtime.auditCleanupStatus();
    assert.equal(failed.database.state, 'failed');
    assert.equal(failed.files.state, 'failed');
    assert.equal(failed.database.lastSuccessAt, undefined);
    assert.equal(failed.files.lastSuccessAt, undefined);

    // Repair BOTH sides out of band, then run the day-cut callback.
    fs.rmSync(notADir, { force: true });
    fs.mkdirSync(notADir, { recursive: true });
    rewriteRuntimeState(stateDir, (s) => ({ ...s, audit: [] }));
    clock = NOW + scheduled.delay;
    const dayCut = scheduled.fn;
    dayCut();

    const healed = runtime.auditCleanupStatus();
    assert.equal(healed.database.state, 'ok', '★★★ 恢复后数据库侧必须变 ok');
    assert.equal(healed.files.state, 'ok', '★★★ 恢复后文件侧必须变 ok');
    assert.equal(healed.database.code, undefined, '★★ 成功时不得残留旧失败码');
    assert.equal(healed.files.code, undefined);
    assert.equal(healed.database.lastSuccessAt, clock, '★★ lastSuccessAt 更新到本次成功时间');
    assert.equal(healed.files.lastSuccessAt, clock);
    assertNoLeak(healed, 'RT-CL-4');
  } finally { runtime.close(); }
});

test('RT-CL-5 lastSuccessAt 不被后续失败抹掉：失败仍能看出上次真实成功时间', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-cleanup-'));
  const stateDir = join(dir, 'state');
  const auditRoot = join(dir, 'audit');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  seedRuntimeState(stateDir);
  fs.mkdirSync(auditRoot, { recursive: true });

  let scheduled = null;
  let clock = NOW;
  const runtime = await openQzoneConsoleRuntime({
    ...pruneConfig(stateDir, { auditJsonlDir: auditRoot }),
    now: () => clock,
    schedule: (fn, delay) => { scheduled = { fn, delay }; return { unref() {} }; },
  });
  try {
    const firstOk = runtime.auditCleanupStatus();
    assert.equal(firstOk.database.state, 'ok');
    assert.equal(firstOk.files.state, 'ok');
    const successStamp = firstOk.files.lastSuccessAt;

    // Break BOTH sides, then run the day-cut: both must fail while the earlier success time stays.
    rewriteRuntimeState(stateDir, (s) => ({ ...s, audit: 'CORRUPT-AUDIT' }));
    fs.rmSync(auditRoot, { recursive: true, force: true });
    fs.writeFileSync(auditRoot, 'not a directory', 'utf8');
    clock = NOW + 3600000;
    const dayCut = scheduled.fn;
    dayCut();

    const failed = runtime.auditCleanupStatus();
    assert.equal(failed.database.state, 'failed', '★★ 数据库侧本次失败');
    assert.equal(failed.files.state, 'failed', '★★ 文件侧本次失败');
    assert.equal(failed.database.lastSuccessAt, successStamp,
      '★★★ 失败不得抹掉上次成功时间（数据库侧）');
    assert.equal(failed.files.lastSuccessAt, successStamp,
      '★★★ 失败不得抹掉上次成功时间（文件侧）');
    assert.equal(failed.database.lastAttemptAt, clock, '★ 尝试时间推进到本次');
    assertNoLeak(failed, 'RT-CL-5');
  } finally { runtime.close(); }
});

test('RT-CL-6 两侧独立：一侧失败不污染另一侧（双向）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-cleanup-'));
  const stateDir = join(dir, 'state');
  const auditRoot = join(dir, 'audit');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  // (a) database broken, files healthy
  seedRuntimeState(stateDir);
  rewriteRuntimeState(stateDir, (s) => ({ ...s, audit: 'CORRUPT-AUDIT' }));
  fs.mkdirSync(auditRoot, { recursive: true });
  fs.writeFileSync(join(auditRoot, '2019-01-01.jsonl'), '{}\n', 'utf8');
  const a = await openQzoneConsoleRuntime(pruneConfig(stateDir, { auditJsonlDir: auditRoot }));
  try {
    const s = a.auditCleanupStatus();
    assert.equal(s.database.state, 'failed', '★★ 数据库侧失败');
    assert.equal(s.files.state, 'ok', '★★★ 文件侧必须仍然成功（不得被牵连）');
    assert.equal(s.files.lastRemoved, 1, '★ 文件侧真的删了过期文件');
  } finally { a.close(); }

  // (b) files broken, database healthy
  await rm(auditRoot, { recursive: true, force: true });
  const notADir = join(dir, 'audit-root-file');
  fs.writeFileSync(notADir, 'not a directory', 'utf8');
  rewriteRuntimeState(stateDir, (s) => ({ ...s, audit: [] }));
  const b = await openQzoneConsoleRuntime(pruneConfig(stateDir, { auditJsonlDir: notADir }));
  try {
    const s = b.auditCleanupStatus();
    assert.equal(s.database.state, 'ok', '★★★ 数据库侧必须仍然成功');
    assert.equal(s.files.state, 'failed', '★★ 文件侧失败');
  } finally { b.close(); }
});

test('RT-CL-7 未配置 auditJsonlDir ⇒ files 为 disabled 且一个文件都不碰；读取状态零副作用', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-cleanup-'));
  const stateDir = join(dir, 'state');
  const auditRoot = join(dir, 'audit');
  const baitRoot = join(stateDir, 'qzone-audit');   // where a "guess a default" impl would land
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  seedRuntimeState(stateDir);
  const seededAudit = seedAuditFiles(auditRoot, NOW);
  const seededBait = seedAuditFiles(baitRoot, NOW);
  const EXPECTED_AUDIT = [seededAudit.oldName, seededAudit.newName].sort();
  const EXPECTED_BAIT = [seededBait.oldName, seededBait.newName].sort();

  const runtime = await openQzoneConsoleRuntime(pruneConfig(stateDir));   // no auditJsonlDir
  const dbPath = join(stateDir, 'qzone-console-state.sqlite');
  const digest = () => createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  const list = (root) => (fs.existsSync(root) ? fs.readdirSync(root).sort() : []);
  try {
    // No files touched: both directories are byte-identical in listing to before the runtime.
    assert.deepEqual(list(auditRoot), EXPECTED_AUDIT,
      '★★★ 未配置文件侧：一个文件都不得被删');
    assert.deepEqual(list(baitRoot), EXPECTED_BAIT,
      '★★★ 更不得按 stateDir 猜目录去删');

    const first = runtime.auditCleanupStatus();
    assert.equal(first.files.state, 'disabled', '★★★ 未配置 ⇒ files 是 disabled（不是 idle/ok）');
    assert.equal(first.files.lastAttemptAt, undefined, '★ disabled 侧从未尝试过');
    assert.equal(first.database.state, 'ok', '★ 数据库侧照常工作');

    // Reading the status is PURE: twice in a row, same answer, and not one byte changed.
    const dbBefore = digest();
    const auditBefore = list(auditRoot);
    const baitBefore = list(baitRoot);
    const second = runtime.auditCleanupStatus();
    assert.deepEqual(second, first, '★★★ 连调两次结果逐字相同（读状态不触发清理）');
    assert.equal(digest(), dbBefore, '★★★ 读状态不改数据库字节');
    assert.deepEqual(list(auditRoot), auditBefore, '★★★ 读状态不碰文件');
    assert.deepEqual(list(baitRoot), baitBefore);
    assertNoLeak(first, 'RT-CL-7');
  } finally { runtime.close(); }
});

test('RT-CL-8 日切调度失败 ⇒ schedule 报 stopped + 闭集 code，启动仍成功', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-cleanup-'));
  const stateDir = join(dir, 'state');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  seedRuntimeState(stateDir);

  // THE BASELINE THIS REPLACES: a throwing `schedule` made construction reject.
  const runtime = await openQzoneConsoleRuntime({
    ...pruneConfig(stateDir),
    schedule: () => { throw new Error('timer unavailable: C:\\secret\\path'); },
  });
  try {
    const status = runtime.auditCleanupStatus();
    assert.equal(status.schedule.state, 'stopped', '★★★ 安排失败不得继续报 scheduled');
    assert.equal(status.schedule.code, 'schedule-threw', '★★ 闭集 code 说明原因类别');
    assert.equal(status.database.state, 'ok', '★ 清理本身不受影响');
    assertNoLeak(status, 'RT-CL-8');
  } finally { runtime.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// RT-CL-11 · THE FOUR RESIDUALS AROUND THE CLOCK (t36)
//
// The main counterexample (a throwing clock escaping the day-cut) is pinned by RT-CL-10a..10c.
// These are the same defect class one layer down — each one measured before it was fixed:
//
//   F4  a FINITE clock value outside Date's range (8.64e15+1) passed the guard, then blew up inside
//       `beijingDay` and was reported as `store-update-failed` / `io-error` while the database and
//       the disk were healthy.
//   F1  the files side read the caller's clock TWICE (`readClock()` here + `clock()` inside
//       `prune()`), so a clock that broke only on the second read failed inside the sink, where the
//       only vocabulary is filesystem codes ⇒ `io-error` / `permission-denied` for a healthy disk.
//   F2  a `schedule` handle whose `unref()` throws left `schedule.state === 'scheduled'` with no live
//       timer — the exact "fake scheduled" state, and the backstop block that fixes it had no test.
//   F3  `timer?.unref?.()` sat outside every try, so a rejected construction could leave a LIVE timer.
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** Build a runtime whose clock can be switched to a broken mode mid-flight. */
async function clockWorld(t, { auditRoot = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-clock-'));
  const stateDir = join(dir, 'state');
  const root = auditRoot ? join(dir, 'audit') : undefined;
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  seedRuntimeState(stateDir);
  if (root) {
    fs.mkdirSync(root, { recursive: true });
    // A day file that is expired relative to the boot clock, so the files side really deletes.
    fs.writeFileSync(join(root, '2019-01-01.jsonl'), '{}\n', 'utf8');
  }
  const BOOT = Date.UTC(2026, 10, 14, 4);
  const world = { dir, stateDir, root, BOOT, mode: 'ok', value: undefined, reads: 0, scheduled: [], cancels: 0 };
  const runtime = await openQzoneConsoleRuntime({
    ...pruneConfig(stateDir, root === undefined ? {} : { auditJsonlDir: root }),
    now: () => {
      world.reads += 1;
      if (world.mode === 'throw') throw new Error('SYNTHETIC_CLOCK_FAILURE');
      if (world.mode === 'out-of-range') return 8.64e15 + 1;
      if (world.mode === 'value') return world.value;
      return BOOT;
    },
    schedule: (fn, delay) => { world.scheduled.push({ fn, delay }); return { unref() {} }; },
  });
  world.runtime = runtime;
  return world;
}

test('RT-CL-11a 超范围时钟（有限但超出 Date 表示范围）⇒ clock-invalid，不得报成存储故障（F4）', async (t) => {
  const w = await clockWorld(t, { auditRoot: true });
  try {
    const bootReads = w.reads;
    assert.equal(w.runtime.auditCleanupStatus().files.state, 'ok', '前提：构造期两侧成功');
    assert.equal(fs.existsSync(join(w.root, '2019-01-01.jsonl')), false, '前提：构造期真的删了过期文件');

    // A FINITE but unrepresentable value: `Number.isFinite` is true, `new Date(v)` is invalid.
    w.mode = 'out-of-range';
    w.scheduled[0].fn();   // day-cut

    const st = w.runtime.auditCleanupStatus();
    assert.equal(st.database.state, 'failed', '★★★ 数据库侧必须失败');
    assert.equal(st.database.code, 'clock-invalid',
      '★★★ 必须是 clock-invalid —— 修复前这里是 store-update-failed（数据库好好的）');
    assert.equal(st.files.state, 'failed', '★★★ 文件侧必须失败');
    assert.equal(st.files.code, 'clock-invalid',
      '★★★ 必须是 clock-invalid —— 修复前这里是 io-error（磁盘好好的）');
    assert.equal(st.schedule.state, 'stopped', '★★ 无法重排 ⇒ 不得报 scheduled');
    assert.equal(st.schedule.code, 'clock-invalid');
    assert.equal(st.database.lastSuccessAt, w.BOOT, '★ 上次成功时间仍保留');
    assert.ok(bootReads >= 4, `前提：构造期确实读了时钟（${bootReads} 次）`);
    assert.ok(w.reads > bootReads, '★ 日切确实又读了时钟（否则本用例是假绿）');
  } finally { w.runtime.close(); }
});

test('RT-CL-11b 文件侧只读一次时钟：内部 clock 是已读 stamp 的透传，不产生第二次读（F1）', async (t) => {
  const w = await clockWorld(t, { auditRoot: true });
  try {
    // The boot sequence reads the caller clock for: beijingDay(initial), database prune, files
    // prune, schedule. The files prune must NOT read it a second time inside `prune()`.
    const bootReads = w.reads;
    assert.equal(bootReads, 4,
      '★★★ 构造期恰好 4 次调用方时钟读取（initialDay / database / files / schedule）；'
      + '修复前是 5 次，多出来的那次发生在 prune() 内部');

    w.reads = 0;
    w.scheduled[0].fn();    // one day-cut
    assert.equal(w.reads, 3,
      '★★★ 一次日切恰好 3 次读取（database / files / schedule）；多一次即文件侧又独立读了时钟');

    // Behavioural consequence: a clock that only breaks AFTER boot cannot be misreported as a disk
    // problem, because the files prune never reaches the sink with a broken clock in hand.
    w.mode = 'throw';
    w.scheduled.at(-1).fn();
    const st = w.runtime.auditCleanupStatus();
    assert.equal(st.files.code, 'clock-invalid',
      '★★★ 时钟坏了必须报 clock-invalid —— 修复前这里会变成 io-error / permission-denied（闭集码说谎）');
    assert.ok(['clock-invalid', 'schedule-threw'].includes(st.schedule.code));
  } finally { w.runtime.close(); }
});

test('RT-CL-11c schedule 句柄 unref 抛错 ⇒ stopped + schedule-threw，两侧清理结果不受影响（F2）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-clock-'));
  const stateDir = join(dir, 'state');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  seedRuntimeState(stateDir);

  const BOOT = Date.UTC(2026, 10, 14, 4);
  let scheduledCalls = 0;
  let dayCut = null;
  // The PUBLIC `schedule` option is enough: its handle throws from `unref()` on the RE-ARM.
  const runtime = await openQzoneConsoleRuntime({
    ...pruneConfig(stateDir),
    now: () => BOOT,
    schedule: (fn) => {
      scheduledCalls += 1;
      dayCut = fn;
      const isFirst = scheduledCalls === 1;
      return { unref() { if (!isFirst) throw new Error('unref unavailable'); } };
    },
  });
  try {
    assert.equal(runtime.auditCleanupStatus().schedule.state, 'scheduled', '前提：构造期已安排');

    let threw = false;
    try { dayCut(); } catch { threw = true; }

    assert.equal(threw, false, '★★ 回调仍不得外抛（unref 抛错被回调体接住）');
    const st = runtime.auditCleanupStatus();
    assert.equal(st.schedule.state, 'stopped',
      '★★★ 没有后继 timer 就必须 stopped —— 删掉回退块这里会回到 scheduled（正是要消灭的假状态）');
    assert.equal(st.schedule.code, 'schedule-threw', '★★ 用既有闭集码，不新增');
    assert.equal(st.database.state, 'ok', '★ 两侧清理本身成功，不受 schedule 影响');
    assert.equal(st.files.state, 'disabled', '★ 未配置文件侧');
  } finally { runtime.close(); }
});

test('RT-CL-11d 构造期 unref 抛错 ⇒ 拒绝构造且不留下活 timer（F3）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-clock-'));
  const stateDir = join(dir, 'state');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  seedRuntimeState(stateDir);

  let created = 0;
  let cancels = 0;
  await assert.rejects(
    openQzoneConsoleRuntime({
      ...pruneConfig(stateDir),
      now: () => Date.UTC(2026, 10, 14, 4),
      schedule: () => { created += 1; return { unref() { throw new Error('unref unavailable'); } }; },
      cancelSchedule: () => { cancels += 1; },
    }),
    /unref unavailable/,
    '★★ 不可信的句柄必须让构造失败（不得静默忽略）',
  );
  assert.equal(created, 1, '前提：确实创建过一个 timer 句柄');
  assert.equal(cancels, 1,
    '★★★ 拒绝构造之前必须先 cancel 那个句柄 —— 修复前 cancelCalls 是 0（活 timer 泄漏）');
  // And the store was closed on the way out, so the same file is usable again.
  const reopened = openOfflineStore(join(stateDir, 'qzone-console-state.sqlite'), {});
  try { assert.equal(reopened.read().selfId, '123'); } finally { reopened.close(); }
});

test('RT-CL-11e 时钟平移后越界（MAX 边界内 8h sliver）⇒ clock-invalid，不得谎报存储故障（t37）', async (t) => {
  // `beijingDay` builds its Date from `timestamp + 8h`, so a raw clock value in `(MAX - 8h, MAX]`
  // passes a naive `abs(value) <= MAX` guard and then throws `RangeError` INSIDE both prunes — which
  // is precisely how a healthy database and disk got reported as `store-update-failed` / `io-error`.
  // Measured on the shipped code before this fix: MAX and MAX-8h+1 both produced those codes.
  const MAX = 8.64e15;
  const H8 = 8 * 60 * 60 * 1000;

  // Precondition, measured here rather than assumed: MAX is unusable for beijingDay, MAX-8h is fine.
  assert.throws(() => beijingDay(MAX), RangeError, '前提：MAX 对 beijingDay 确实越界');
  assert.equal(typeof beijingDay(MAX - H8), 'string', '前提：MAX-8h 对 beijingDay 仍可用');

  for (const [label, value, expect] of [
    ['MAX', MAX, 'failed'],
    ['MAX-8h+1', MAX - H8 + 1, 'failed'],
    ['MAX-8h（边界，必须仍可用）', MAX - H8, 'ok'],
    ['-MAX（负数侧无此问题）', -MAX, 'ok'],
  ]) {
    const w = await clockWorld(t, { auditRoot: true });
    try {
      w.mode = 'value';
      w.value = value;
      w.scheduled[0].fn();          // day-cut under the edge clock

      const st = w.runtime.auditCleanupStatus();
      assert.equal(st.database.state, expect, `★★★ ${label}: database.state 期望 ${expect}`);
      assert.equal(st.files.state, expect, `★★★ ${label}: files.state 期望 ${expect}`);

      if (expect === 'failed') {
        assert.equal(st.database.code, 'clock-invalid',
          `★★★ ${label}: 必须是 clock-invalid —— 修复前这里是 store-update-failed`);
        assert.equal(st.files.code, 'clock-invalid',
          `★★★ ${label}: 必须是 clock-invalid —— 修复前这里是 io-error`);
        for (const forbidden of ['store-update-failed', 'io-error', 'permission-denied', 'unexpected']) {
          assert.notEqual(st.database.code, forbidden, `★★ ${label}: 数据库侧不得再出现 ${forbidden}`);
          assert.notEqual(st.files.code, forbidden, `★★ ${label}: 文件侧不得再出现 ${forbidden}`);
        }
        assert.equal(st.schedule.state, 'stopped', `★★ ${label}: 无法重排 ⇒ 不得报 scheduled`);
        assert.equal(st.schedule.code, 'clock-invalid');
        // A refused attempt must not overwrite the last real success with the garbage clock.
        assert.equal(st.database.lastSuccessAt, w.BOOT, `★ ${label}: 上次真实成功时间保留`);
      } else {
        // The guard must not over-reject: a legitimate boundary value still works end to end, so the
        // success time legitimately ADVANCES to it (that is the positive control, not a leak).
        assert.equal(st.database.code, undefined, `★★ ${label}: 合法边界不得带失败码`);
        assert.equal(st.files.code, undefined);
        assert.equal(st.schedule.state, 'scheduled', `★★ ${label}: 合法边界仍须重排`);
        assert.equal(st.database.lastSuccessAt, value,
          `★★ ${label}: 合法边界下 lastSuccessAt 应推进到本次（证明它真的跑成功了）`);
      }
    } finally { w.runtime.close(); }
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// RT-CL-10 · A THROWING CLOCK — the real day-cut counterexample (Codex, reproduced)
//
// MEASURED BEFORE THIS FIX (same probe the reviewer ran, no new injection interface — only the
// existing `now` / `schedule` constructor options):
//   {"callbackThrew":true,"scheduleCalls":1,
//    "scheduleBefore":{"state":"scheduled"},"scheduleAfter":{"state":"scheduled"},
//    "databaseAfter":{"state":"ok","lastAttemptAt":…,"lastSuccessAt":…,"lastRemoved":0}}
//
// THREE symptoms, all real:
//   · the day-cut callback THREW out into the host event loop (uncaught);
//   · `schedule` still said `scheduled` for a one-shot timer that had already been consumed;
//   · `database` still said `ok` although this attempt never ran.
//
// The "clock RETURNS a non-finite value" path was already handled (RT-CL-9d). These cases pin the
// "clock THROWS" path, which was not, and the re-arm honesty that depended on it.
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('RT-CL-10a 时钟抛错：日切回调不外抛，两侧如实 failed/clock-invalid，schedule 不得滞留 scheduled', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-clock-'));
  const stateDir = join(dir, 'state');
  const auditRoot = join(dir, 'audit');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  seedRuntimeState(stateDir);
  fs.mkdirSync(auditRoot, { recursive: true });

  const BOOT = Date.UTC(2026, 10, 14, 4);
  let clockBroken = false;
  let saved = null;
  let scheduleCalls = 0;
  // One shared object so the config and the callback see the same switch — no new interface.
  const runtime = await openQzoneConsoleRuntime({
    ...pruneConfig(stateDir, { auditJsonlDir: auditRoot }),
    now: () => { if (clockBroken) throw new Error('SYNTHETIC_CLOCK_FAILURE'); return BOOT; },
    schedule: (fn, delay) => { saved = { fn, delay }; scheduleCalls += 1; return { unref() {} }; },
  });
  try {
    const before = runtime.auditCleanupStatus();
    assert.equal(before.schedule.state, 'scheduled', '前提：构造完成后日切已安排');
    assert.equal(before.database.state, 'ok', '前提：构造期的数据库侧清理成功');
    const bootSuccess = before.database.lastSuccessAt;
    assert.equal(bootSuccess, BOOT, '前提：构造期那次成功的 lastSuccessAt 就是构造时钟');

    // Break the clock AFTER a successful construction — exactly the reviewer's shape.
    clockBroken = true;
    let callbackThrew = false;
    try { saved.fn(); } catch { callbackThrew = true; }

    assert.equal(callbackThrew, false,
      '★★★ 日切回调绝不得向外抛（旧实现在这里抛给宿主事件循环）');
    assert.equal(scheduleCalls, 1, '★ 不得偷偷安排新 timer（禁止自动重试）');

    const after = runtime.auditCleanupStatus();
    assert.equal(after.database.state, 'failed', '★★★ 本次没跑成，不得继续报 ok');
    assert.equal(after.database.code, 'clock-invalid', '★★ 闭集码说明是时钟不可用');
    assert.equal(after.files.state, 'failed', '★★ 文件侧同理（两侧各自受控）');
    assert.equal(after.files.code, 'clock-invalid');
    assert.equal(after.database.lastSuccessAt, bootSuccess,
      '★★★ 上一次真实成功时间必须保留，且不得被本次伪造');
    // The failed attempt could not even be STAMPED (the clock is the thing that broke), so the
    // attempt time cannot advance either: it must still be the construction-time value, never a
    // fabricated "now". This is the concrete form of "do not record this attempt as a success".
    assert.equal(after.database.lastAttemptAt, bootSuccess,
      '★★ 本次无法取到时间戳 ⇒ lastAttemptAt 不得凭空推进（也就不会等于一个“本次时间”）');
    assert.equal(after.database.lastRemoved, 0,
      '★ 本次没有删任何东西，lastRemoved 保持上一次的值而非编造');
    assert.equal(after.schedule.state, 'stopped', '★★★ 一次性 timer 已被消费，不得再报 scheduled');
    assert.ok(['clock-invalid', 'schedule-threw'].includes(after.schedule.code),
      `★★ schedule 失败必须带闭集码（实际 ${after.schedule.code}）`);
    assertNoLeak(after, 'RT-CL-10a');

    // A SECOND manual call must also be contained (nothing here may throw or invent success).
    let secondThrew = false;
    try { saved.fn(); } catch { secondThrew = true; }
    assert.equal(secondThrew, false, '★★ 再次触发同样不得外抛');
    assert.equal(runtime.auditCleanupStatus().database.state, 'failed', '★★ 仍然 failed，不得翻回 ok');
  } finally { runtime.close(); }
});

test('RT-CL-10b 正控：时钟正常时日切仍成功、仍重排、仍 scheduled（防止改成永远 stopped）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-clock-'));
  const stateDir = join(dir, 'state');
  const auditRoot = join(dir, 'audit');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  seedRuntimeState(stateDir);
  fs.mkdirSync(auditRoot, { recursive: true });

  let clock = Date.UTC(2026, 10, 14, 4);
  const scheduled = [];
  const runtime = await openQzoneConsoleRuntime({
    ...pruneConfig(stateDir, { auditJsonlDir: auditRoot }),
    now: () => clock,
    schedule: (fn, delay) => { scheduled.push({ fn, delay }); return { unref() {} }; },
  });
  try {
    assert.equal(scheduled.length, 1, '前提：构造期安排了一次');
    clock = Date.UTC(2026, 10, 15, 4);            // one day later
    let threw = false;
    try { scheduled[0].fn(); } catch { threw = true; }
    assert.equal(threw, false, '★ 正常时钟下回调不抛');
    assert.equal(scheduled.length, 2, '★★★ 必须重排后继 timer（不是一次性的）');

    const status = runtime.auditCleanupStatus();
    assert.equal(status.database.state, 'ok', '★★ 本次成功');
    assert.equal(status.database.lastSuccessAt, clock, '★ lastSuccessAt 推进到本次');
    assert.equal(status.schedule.state, 'scheduled', '★★★ 有后继 timer 就必须报 scheduled');
    assert.equal(status.schedule.code, undefined, '★ 成功安排时不得带 code');
  } finally { runtime.close(); }
});

test('RT-CL-10c 构造期时钟不可用 ⇒ 拒绝构造（方案 a），且不留 timer、不泄露句柄', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-runtime-clock-'));
  const stateDir = join(dir, 'state');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  seedRuntimeState(stateDir);

  // The clock works for the prunes and then dies exactly at the scheduling step, so this exercises
  // the CONSTRUCTION-TIME path (not a later callback).
  const BOOT = Date.UTC(2026, 10, 14, 4);
  let calls = 0;
  let scheduleCalls = 0;
  await assert.rejects(
    openQzoneConsoleRuntime({
      ...pruneConfig(stateDir),
      now: () => { calls += 1; if (calls > 2) throw new Error('LATE_CLOCK_FAILURE'); return BOOT; },
      schedule: () => { scheduleCalls += 1; return { unref() {} }; },
    }),
    /invalid clock/,
    '★★★ 构造期时钟不可用必须拒绝构造（方案 a：不带垃圾时钟起 runtime）',
  );
  assert.equal(scheduleCalls, 0, '★ 拒绝构造时不得留下任何 timer');
  assert.ok(calls >= 3, '前提：时钟确实在调度那一步才失败');

  // The store must have been closed by the failure path: the same file reopens cleanly.
  const reopened = openOfflineStore(join(stateDir, 'qzone-console-state.sqlite'), {});
  try {
    assert.equal(reopened.read().selfId, '123', '★★ 构造 reject 后 store 已关闭，同一文件可重新打开');
  } finally { reopened.close(); }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// RT-CL-9 · THE DECISION KERNEL — pins the branch that used to have ZERO coverage
//
// MEASURED BEFORE THIS: deleting the whole `if (removed === null) { … unexpected-report … }` block
// from the runtime left all three suites green (21/21, 9/9, 39/39). The honesty claim — "we read the
// prune's ANSWER, we do not merely catch its exception" — had no test that could tell the branch
// existed. The kernel is now a pure exported function, so the decision can be driven directly from
// a test with no injection seam, no test-only switch and no exported mutable state.
//
// This is the case that must go RED if anyone turns "unreadable report" back into "success".
// ══════════════════════════════════════════════════════════════════════════════════════════════

const STAMP = NOW + 12345;

test('RT-CL-9a 决策内核：不可解读的报告 ⇒ failed/unexpected-report（这条红即“任何形状都算成功”回归）', () => {
  // Every shape here is something a prune could return that tells us nothing usable.
  const unreadable = [
    ['空对象（无 removed）', {}],
    ['字符串', 'removed-3'],
    ['null', null],
    ['undefined', undefined],
    ['removed 为负数', { removed: -1 }],
    ['removed 是字符串', { removed: '1' }],
    ['removed 是 NaN', { removed: Number.NaN }],
    ['removed 是小数', { removed: 1.5 }],
    ['removed 是对象', { removed: {} }],
  ];
  for (const [label, report] of unreadable) {
    // ⚠️ DRIVEN BY THE SHIPPED INTERPRETER (`interpretDatabaseReport`), not by a restated lambda.
    // Terminal review F1: the old inline lambda was a SECOND copy of this logic, so a mutation that
    // broke the real one stayed green. Importing the real one is what makes M-C observable.
    const outcome = applyCleanupOutcome({
      stamp: STAMP, report, threw: false, interpret: interpretDatabaseReport,
    });
    assert.equal(outcome.state, 'failed', `★★★ ${label}: 不可解读的报告不得算成功`);
    assert.equal(outcome.code, 'unexpected-report', `★★ ${label}: 必须是 unexpected-report 这个闭集码`);
    assert.equal(outcome.lastAttemptAt, STAMP, `★ ${label}: 失败也要记下尝试时间`);
    assert.equal(Object.hasOwn(outcome, 'lastSuccessAt'), false,
      `★★★ ${label}: 不得写入 lastSuccessAt（没成功就没有成功时间）`);
    assert.equal(Object.hasOwn(outcome, 'lastRemoved'), false, `★ ${label}: 不得编造删除数`);
  }
});

test('RT-CL-9f 内核收口是“值判定”：解释器漏写 return / 吐非法值时也必须落 failed（F2）', () => {
  // These drive the KERNEL directly with the pathological RETURN VALUES a broken interpreter would
  // produce. The shipped interpreters happen to map all of these to `null`, so this case is what
  // keeps the kernel honest even if one of them later forgets to.
  const badCounts = [
    ['undefined（漏写 return）', undefined],
    ['null（形状不可读出口）', null],
    ['负数', -1],
    ['字符串数字', '3'],
    ['NaN', Number.NaN],
    ['小数', 1.5],
    ['空对象', {}],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['超出安全整数', Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [label, value] of badCounts) {
    const outcome = applyCleanupOutcome({
      stamp: STAMP, report: 'ignored', threw: false, interpret: () => value,
    });
    assert.equal(outcome.state, 'failed', `★★★ ${label}: 非计数值不得算成功`);
    assert.equal(outcome.code, 'unexpected-report', `★★ ${label}: 必须 unexpected-report`);
    assert.equal(Object.hasOwn(outcome, 'lastSuccessAt'), false, `★★★ ${label}: 不得写 lastSuccessAt`);
    assert.equal(Object.hasOwn(outcome, 'lastRemoved'), false, `★★★ ${label}: 不得把垃圾写进 lastRemoved`);
  }
  // Positive control: 0 and 3 are COUNTS and must stay successes (the fix must not over-reject).
  for (const [label, value] of [['0', 0], ['3', 3]]) {
    const outcome = applyCleanupOutcome({
      stamp: STAMP, report: 'ignored', threw: false, interpret: () => value,
    });
    assert.equal(outcome.state, 'ok', `★★ ${label}: 合法计数必须仍算成功`);
    assert.equal(outcome.lastRemoved, value);
    assert.equal(outcome.lastSuccessAt, STAMP);
  }
});

test('RT-CL-9b 决策内核：0 也是成功（removed:0 不等于“没做事就是失败”）', () => {
  const dbOutcome = applyCleanupOutcome({
    stamp: STAMP, report: { removed: 0 }, threw: false, interpret: interpretDatabaseReport,
  });
  assert.equal(dbOutcome.state, 'ok', '★★★ 数据库侧 removed:0 必须算成功');
  assert.equal(dbOutcome.code, undefined, '★ 成功必须清除旧 code（undefined 表示删除该键）');
  assert.equal(dbOutcome.lastSuccessAt, STAMP);
  assert.equal(dbOutcome.lastRemoved, 0);

  const fileOutcome = applyCleanupOutcome({
    stamp: STAMP, report: { removed: [], kept: 7 }, threw: false, interpret: interpretFilesReport,
  });
  assert.equal(fileOutcome.state, 'ok', '★★★ 文件侧 removed:[] 也必须算成功');
  assert.equal(fileOutcome.lastRemoved, 0);
  assert.equal(fileOutcome.lastSuccessAt, STAMP);

  // Non-vacuity: the SAME shipped interpreter must REJECT its own malformed reports, so the success
  // above is not "this interpreter says yes to everything".
  for (const bad of [{}, { removed: [] }, { removed: '1', kept: 0 }, { removed: [], kept: -1 }, { removed: [], kept: 1.5 }]) {
    assert.equal(interpretFilesReport(bad), null, `★★ 文件侧解释器必须拒 ${JSON.stringify(bad)}`);
  }
  for (const bad of [{}, { removed: -1 }, { removed: '1' }, { removed: 1.5 }, { removed: Number.NaN }]) {
    assert.equal(interpretDatabaseReport(bad), null, `★★ 数据库侧解释器必须拒 ${JSON.stringify(bad)}`);
  }
});

test('RT-CL-9c 决策内核：throw ⇒ failed + 失败码，且绝不动 lastSuccessAt', () => {
  const outcome = applyCleanupOutcome({
    stamp: STAMP, report: undefined, threw: true,
    interpret: () => 0,
    failureCode: 'permission-denied',
  });
  assert.equal(outcome.state, 'failed', '★★ 抛错必须记为 failed');
  assert.equal(outcome.code, 'permission-denied', '★ 失败码来自调用方给的闭集 token');
  assert.equal(outcome.lastAttemptAt, STAMP);
  assert.equal(Object.hasOwn(outcome, 'lastSuccessAt'), false,
    '★★★ 抛错时不得触碰 lastSuccessAt —— 合并到已有记录时它必须保留原值');

  // A throw with no usable code still yields a closed-set token, never `undefined`.
  const fallback = applyCleanupOutcome({ stamp: STAMP, threw: true, interpret: () => 0 });
  assert.equal(fallback.code, 'unexpected', '★ 缺省失败码必须是闭集里的 unexpected');
});

test('RT-CL-9d 决策内核：时钟不可用 ⇒ failed/clock-invalid，不记尝试时间', () => {
  for (const stamp of [undefined, Number.NaN, Infinity, '123']) {
    const outcome = applyCleanupOutcome({ stamp, report: { removed: 0 }, threw: false, interpret: () => 0 });
    assert.equal(outcome.state, 'failed', `★ stamp=${String(stamp)}: 不可用的时钟不得记成功`);
    assert.equal(outcome.code, 'clock-invalid');
    assert.equal(Object.hasOwn(outcome, 'lastAttemptAt'), false, '★ 没有可用时钟就没有尝试时间');
  }
});

test('RT-CL-9e 决策内核是纯函数：不改参数、返回冻结对象', () => {
  const report = { removed: 2 };
  const snapshot = JSON.stringify(report);
  const outcome = applyCleanupOutcome({ stamp: STAMP, report, threw: false, interpret: (r) => r.removed });
  assert.equal(JSON.stringify(report), snapshot, '★★ 入参 report 不得被修改');
  assert.equal(Object.isFrozen(outcome), true, '★ 返回值必须冻结（调用方拿不到可改的活对象）');
  assert.throws(() => { outcome.state = 'ok'; }, TypeError, '★ 冻结对象在严格模式下写入即抛');
  // A null-ish options object must not crash: it degrades to the clock-invalid verdict.
  assert.equal(applyCleanupOutcome().code, 'clock-invalid');
});
