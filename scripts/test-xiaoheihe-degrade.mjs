/**
 * A-2：xiaoheihe-degrade 纯状态模块测试。
 *
 * 全部离线：临时目录 + 注入 clock；不触碰 state/、不启动桥接、不联网。
 * 每个用例独立临时目录，t.after 清理。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  XHH_DEGRADE_SCHEMA_VERSION,
  XHH_DEGRADE_LEVELS,
  XHH_DEGRADE_RANK,
  XHH_DEGRADE_TRIGGERS,
  createXiaoheiheDegrade,
} from '../src/core/xiaoheihe-degrade.mjs';

const START = 1_800_000_000_000;

async function makeDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xhh-degrade-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeGuard(dir, overrides = {}) {
  const filePath = path.join(dir, 'xiaoheihe-degrade.json');
  let now = START;
  const logs = [];
  const notifyEvents = [];
  const guard = createXiaoheiheDegrade({
    filePath,
    clock: () => now,
    notify: (event) => { notifyEvents.push(event); },
    logger: (level, code) => { logs.push([level, code]); },
    ...overrides,
  });
  return {
    guard,
    filePath,
    logs,
    notifyEvents,
    advance: (ms) => { now += ms; },
    setNow: (value) => { now = value; },
    getNow: () => now,
  };
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

test('① 无状态文件 → load 返回 normal，snapshot 放行', async (t) => {
  const dir = await makeDir(t);
  const { guard, filePath } = makeGuard(dir);
  const loaded = await guard.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.level, 'normal');
  assert.equal(loaded.failClosed, undefined);
  assert.deepEqual(loaded.notify, { status: null, attempts: 0, operationId: null, lastCode: null });
  const snapshot = guard.snapshot();
  assert.equal(snapshot.level, 'normal');
  assert.equal(snapshot.blockWrite, false);
  assert.equal(snapshot.blockAll, false);
  await assert.rejects(fsp.readFile(filePath, 'utf8'), /ENOENT/);
});

test('② enter read-only 先落盘后改内存；新实例读回一致', async (t) => {
  const dir = await makeDir(t);
  const { guard, filePath, advance } = makeGuard(dir);
  await guard.load();
  advance(1000);
  const entered = await guard.enter({ level: 'read-only', trigger: 'identity-guard-unavailable' });
  assert.equal(entered.ok, true);
  assert.equal(entered.level, 'read-only');
  assert.equal(guard.snapshot().level, 'read-only');
  assert.equal(guard.snapshot().blockWrite, true);
  assert.equal(guard.snapshot().blockAll, false);
  const disk = await readJson(filePath);
  assert.equal(disk.schemaVersion, XHH_DEGRADE_SCHEMA_VERSION);
  assert.equal(disk.level, 'read-only');
  assert.equal(disk.trigger, 'identity-guard-unavailable');
  assert.equal(disk.since, START + 1000);
  const again = createXiaoheiheDegrade({ filePath, clock: () => START + 2000 });
  const reloaded = await again.load();
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.level, 'read-only');
  assert.equal(reloaded.trigger, 'identity-guard-unavailable');
});

test('③ rank 只拒下降：paused 下 enter read-only 被拒且磁盘/内存不变', async (t) => {
  const dir = await makeDir(t);
  const { guard, filePath } = makeGuard(dir);
  await guard.load();
  assert.equal((await guard.enter({ level: 'paused', trigger: 'notify-failed' })).ok, true);
  const refused = await guard.enter({ level: 'read-only', trigger: 'manual' });
  assert.deepEqual(refused, { ok: false, reason: 'degrade-rank-downgrade-refused' });
  assert.equal(guard.snapshot().level, 'paused');
  assert.equal((await readJson(filePath)).level, 'paused');
  // rank 相等允许（补记事实字段）
  assert.equal((await guard.enter({ level: 'paused', trigger: 'manual' })).ok, true);
  assert.equal(guard.snapshot().trigger, 'manual');
});

test('④ 坏文件三类 → fail-closed paused（重启仍是 paused，不当正常）', async (t) => {
  const dir = await makeDir(t);
  const cases = [
    ['not-json', '{oops', 'state-corrupt'],
    ['missing-level', JSON.stringify({ schemaVersion: 1, trigger: null, since: null, identityOk: null }), 'state-invalid'],
    ['schema-2', JSON.stringify({ schemaVersion: 2, level: 'normal', trigger: null, since: null, identityOk: null }), 'schema-version-unsupported'],
    ['bad-level', JSON.stringify({ schemaVersion: 1, level: 'writes-paused', trigger: null, since: null, identityOk: null }), 'state-invalid'],
    ['bad-notify', JSON.stringify({ schemaVersion: 1, level: 'read-only', trigger: null, since: null, identityOk: null, notify: { status: 'pending', attempts: 0 } }), 'state-invalid'],
  ];
  for (const [name, raw, reason] of cases) {
    const filePath = path.join(dir, `${name}.json`);
    await fsp.writeFile(filePath, raw, 'utf8');
    const first = createXiaoheiheDegrade({ filePath, clock: () => START });
    const loaded = await first.load();
    assert.equal(loaded.ok, true, name);
    assert.equal(loaded.failClosed, true, name);
    assert.equal(loaded.level, 'paused', name);
    assert.equal(loaded.reason, reason, name);
    assert.equal(first.snapshot().blockAll, true, name);
    assert.equal(first.snapshot().blockWrite, true, name);
    // 重启：仍然是 paused（坏文件不能当正常）
    const second = createXiaoheiheDegrade({ filePath, clock: () => START });
    const reloaded = await second.load();
    assert.equal(reloaded.failClosed, true, name);
    assert.equal(reloaded.level, 'paused', name);
  }
});

test('⑤a 通知 failed 第一次即 paused（trigger=notify-failed）；随后 delivered + identityOk 不得抬回，只能手动恢复', async (t) => {
  const dir = await makeDir(t);
  const { guard, advance } = makeGuard(dir);
  await guard.load();
  await guard.enter({ level: 'read-only', trigger: 'identity-guard-unavailable' });
  advance(1000);
  const marked = await guard.markNotify({ status: 'failed', operationId: 'op-1', lastCode: 'NO_MESSAGE_ID' });
  assert.equal(marked.ok, true);
  assert.equal(marked.attempts, 1);
  assert.equal(marked.escalated, true);
  assert.equal(marked.level, 'paused');
  assert.equal(guard.snapshot().level, 'paused');
  assert.equal(guard.snapshot().trigger, 'notify-failed');
  assert.equal(guard.snapshot().blockAll, true);
  assert.equal(guard.snapshot().blockWrite, true);
  // 补报成功也不能抬回：用户口径「不得因为随后一次通知 delivered 就自动解除已经进入的全停状态」
  advance(1000);
  const delivered = await guard.markNotify({ status: 'delivered', operationId: 'op-1' });
  assert.equal(delivered.attempts, 2);
  assert.equal(delivered.level, 'paused');
  const restored = await guard.recordIdentityOk(true);
  assert.equal(restored.ok, true);
  assert.equal(restored.level, 'paused');
  assert.equal(restored.autoLifted, false);
  assert.equal(guard.snapshot().level, 'paused');
  assert.equal(guard.snapshot().trigger, 'notify-failed');
  // 手动恢复（管理员确认）才回到 normal
  const recovery = await guard.applyManualRecovery({ confirmed: true, operator: 'console-admin' });
  assert.equal(recovery.ok, true);
  assert.equal(guard.snapshot().level, 'normal');
  assert.equal(guard.snapshot().blockAll, false);
});

test('⑤b 通知 unknown 第一次即 paused（trigger=notify-unknown）；delivered 同样不得抬回', async (t) => {
  const dir = await makeDir(t);
  const { guard, advance } = makeGuard(dir);
  await guard.load();
  await guard.enter({ level: 'read-only', trigger: 'identity-mode-legacy' });
  advance(1000);
  const marked = await guard.markNotify({ status: 'unknown', operationId: 'op-u', lastCode: 'NO_MESSAGE_ID' });
  assert.equal(marked.ok, true);
  assert.equal(marked.attempts, 1);
  assert.equal(marked.escalated, true);
  assert.equal(guard.snapshot().level, 'paused');
  assert.equal(guard.snapshot().trigger, 'notify-unknown');
  assert.equal(guard.snapshot().blockAll, true);
  await guard.markNotify({ status: 'delivered', operationId: 'op-u' });
  const restored = await guard.recordIdentityOk(true);
  assert.equal(restored.level, 'paused');
  assert.equal(restored.autoLifted, false);
  assert.equal(guard.snapshot().level, 'paused');
  assert.equal(guard.snapshot().trigger, 'notify-unknown');
  const recovery = await guard.applyManualRecovery({ confirmed: true, operator: 'console-admin' });
  assert.equal(recovery.ok, true);
  assert.equal(guard.snapshot().level, 'normal');
});

test('⑤c 身份异常进入的 paused：delivered + identityOk 也不得自动解除（只有手动恢复）', async (t) => {
  const dir = await makeDir(t);
  const { guard } = makeGuard(dir);
  await guard.load();
  await guard.enter({ level: 'paused', trigger: 'identity-guard-unavailable' });
  await guard.markNotify({ status: 'delivered', operationId: 'op-p' });
  assert.equal(guard.snapshot().level, 'paused');
  const restored = await guard.recordIdentityOk(true);
  assert.equal(restored.ok, true);
  assert.equal(restored.level, 'paused');
  assert.equal(restored.autoLifted, false);
  assert.equal(guard.snapshot().level, 'paused');
  assert.equal(guard.snapshot().trigger, 'identity-guard-unavailable');
  const recovery = await guard.applyManualRecovery({ confirmed: true, operator: 'console-admin' });
  assert.equal(recovery.ok, true);
  assert.equal(guard.snapshot().level, 'normal');
});

test('⑥ delivered + identityOk=true → 自动回 normal（仅解除本异常引入的限制）', async (t) => {
  const dir = await makeDir(t);
  const { guard, filePath, advance } = makeGuard(dir);
  await guard.load();
  await guard.enter({ level: 'read-only', trigger: 'identity-mode-legacy' });
  advance(500);
  assert.equal((await guard.markNotify({ status: 'delivered', operationId: 'op-2' })).status, 'delivered');
  const restored = await guard.recordIdentityOk(true);
  assert.equal(restored.ok, true);
  assert.equal(restored.level, 'normal');
  assert.equal(guard.snapshot().blockWrite, false);
  assert.equal(guard.snapshot().blockAll, false);
  assert.equal(guard.snapshot().trigger, null);
  const disk = await readJson(filePath);
  assert.equal(disk.level, 'normal');
  assert.equal(disk.identityOk, true);
});

test('⑥b identityOk=true 但通知尚未 delivered → 保持 read-only', async (t) => {
  const dir = await makeDir(t);
  const { guard } = makeGuard(dir);
  await guard.load();
  await guard.enter({ level: 'read-only', trigger: 'identity-guard-load-failed' });
  const restored = await guard.recordIdentityOk(true);
  assert.equal(restored.level, 'read-only');
  assert.equal(guard.snapshot().level, 'read-only');
});

test('⑦ 手动恢复需 confirmed:true + 非空 operator；成功清空 notify', async (t) => {
  const dir = await makeDir(t);
  const { guard, filePath } = makeGuard(dir);
  await guard.load();
  await guard.enter({ level: 'paused', trigger: 'notify-failed' });
  await guard.markNotify({ status: 'failed', operationId: 'op-3' });
  assert.deepEqual(await guard.applyManualRecovery({ confirmed: false, operator: 'admin' }), { ok: false, reason: 'recovery-not-confirmed' });
  assert.deepEqual(await guard.applyManualRecovery({ confirmed: true, operator: '   ' }), { ok: false, reason: 'invalid-operator' });
  assert.deepEqual(await guard.applyManualRecovery({ confirmed: true, operator: 42 }), { ok: false, reason: 'invalid-operator' });
  assert.equal(guard.snapshot().level, 'paused');
  const recovered = await guard.applyManualRecovery({ confirmed: true, operator: 'console-admin' });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.level, 'normal');
  assert.equal(guard.snapshot().trigger, null);
  assert.deepEqual(guard.snapshot().notify, { status: null, attempts: 0, operationId: null, lastCode: null });
  const disk = await readJson(filePath);
  assert.equal(disk.level, 'normal');
  assert.equal(disk.notify.status, null);
});

test('⑧ 写盘失败 → 不冒充成功，也不改内存', async (t) => {
  const dir = await makeDir(t);
  const sub = path.join(dir, 'sub');
  const filePath = path.join(sub, 'xiaoheihe-degrade.json');
  const guard = createXiaoheiheDegrade({ filePath, clock: () => START });
  // 目录尚不存在（ENOENT）→ 正常内存态；随后把父路径变成普通文件，让 mkdir/写盘失败。
  const loaded = await guard.load();
  assert.equal(loaded.level, 'normal');
  await fsp.writeFile(sub, 'not a dir', 'utf8');
  const entered = await guard.enter({ level: 'read-only', trigger: 'identity-guard-unavailable' });
  assert.deepEqual(entered, { ok: false, reason: 'degrade-persist-failed' });
  assert.equal(guard.snapshot().level, 'normal');
  assert.equal(guard.snapshot().blockWrite, false);
});

test('⑨ 新实例 load 读回 paused（重启保持）', async (t) => {
  const dir = await makeDir(t);
  const { guard, filePath } = makeGuard(dir);
  await guard.load();
  await guard.enter({ level: 'paused', trigger: 'notify-failed' });
  const restarted = createXiaoheiheDegrade({ filePath, clock: () => START + 9999 });
  const loaded = await restarted.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.level, 'paused');
  assert.equal(loaded.trigger, 'notify-failed');
  assert.equal(restarted.snapshot().blockAll, true);
});

test('⑩ .tmp 残留不影响 load（崩在半路也不留半个状态）', async (t) => {
  const dir = await makeDir(t);
  const { guard, filePath } = makeGuard(dir);
  await fsp.writeFile(`${filePath}.tmp`, '{half-written', 'utf8');
  const first = await guard.load();
  assert.equal(first.level, 'normal');
  assert.equal(first.failClosed, undefined);
  assert.equal((await guard.enter({ level: 'read-only', trigger: 'manual' })).ok, true);
  await fsp.writeFile(`${filePath}.tmp`, '{another half', 'utf8');
  const restarted = createXiaoheiheDegrade({ filePath, clock: () => START });
  const loaded = await restarted.load();
  assert.equal(loaded.level, 'read-only');
  assert.equal(loaded.failClosed, undefined);
});

test('⑪ enter 参数校验：非法 level / 非法 trigger → invalid-argument', async (t) => {
  const dir = await makeDir(t);
  const { guard, filePath } = makeGuard(dir);
  await guard.load();
  assert.deepEqual(await guard.enter({ level: 'all-paused', trigger: 'manual' }), { ok: false, reason: 'invalid-argument' });
  assert.deepEqual(await guard.enter({ level: 'read-only', trigger: 'nonsense' }), { ok: false, reason: 'invalid-argument' });
  assert.equal(guard.snapshot().level, 'normal');
  await assert.rejects(fsp.readFile(filePath, 'utf8'), /ENOENT/);
});

test('⑫ 落盘 JSON：LF 换行、稳定键序、含全部字段', async (t) => {
  const dir = await makeDir(t);
  const { guard, filePath } = makeGuard(dir);
  await guard.load();
  await guard.enter({ level: 'read-only', trigger: 'identity-guard-unavailable' });
  const raw = await fsp.readFile(filePath, 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.ok(!raw.includes('\r'));
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed), ['schemaVersion', 'level', 'trigger', 'since', 'updatedAt', 'identityOk', 'notify']);
  assert.deepEqual(Object.keys(parsed.notify), ['status', 'attempts', 'operationId', 'lastCode']);
});

test('⑬ 模块只 import node:fs/promises 与 node:path（不连 bridge/hook/guard/网络）', async () => {
  const source = await fsp.readFile(new URL('../src/core/xiaoheihe-degrade.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import\s+.*from\s+'([^']+)'/gm)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), ['node:fs/promises', 'node:path']);
  assert.doesNotMatch(source, /from\s+['"]\.\.?\/.*(bridge|authorize|hook|guard)/);
  assert.doesNotMatch(source, /https?:\/\//);
});

test('⑭ 常量导出与冻结语义', () => {
  assert.equal(XHH_DEGRADE_SCHEMA_VERSION, 1);
  assert.deepEqual([...XHH_DEGRADE_LEVELS], ['normal', 'read-only', 'paused']);
  assert.deepEqual({ ...XHH_DEGRADE_RANK }, { normal: 0, 'read-only': 1, paused: 2 });
  assert.deepEqual([...XHH_DEGRADE_TRIGGERS], [
    'identity-guard-unavailable',
    'identity-guard-load-failed',
    'identity-mode-legacy',
    'notify-failed',
    'notify-unknown',
    'manual',
  ]);
  assert.equal(Object.isFrozen(XHH_DEGRADE_LEVELS), true);
  assert.equal(Object.isFrozen(XHH_DEGRADE_RANK), true);
  assert.equal(Object.isFrozen(XHH_DEGRADE_TRIGGERS), true);
});
