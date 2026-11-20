import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import * as admin from '../src/core/qzone-admin-offline.mjs';
import { settleOfflineRead } from '../src/core/qzone-settlement-offline.mjs';

test('配置持久保存并与管理审计同事务，禁止非法值或缺少身份', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'state.db');
  const initial = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: true, writePaused: true,
    tools: { publish: true, like: true }, limits: { post: 3, comment: 25, like: 30 }, intervalMinutes: 100,
    activeStart: 420, activeEnd: 1380, audit: [], used: { post: 2 } };
  db = openOfflineStore(file, initial);
  assert.equal(typeof admin.configureOfflineQzone, 'function');
  const actor = { operator: '123', source: 'admin_console', target: '123', time: 1000, auditId: 'config1' };
  assert.throws(() => admin.configureOfflineQzone(db, { limits: { post: 100 } }, actor));
  assert.throws(() => admin.configureOfflineQzone(db, { intervalMinutes: 14 }, actor));
  assert.throws(() => admin.configureOfflineQzone(db, { enabled: false }, { ...actor, operator: '' }));
  assert.equal(db.read().enabled, true);
  assert.equal(db.read().audit.length, 0);
  admin.configureOfflineQzone(db, { enabled: false, tools: { publish: false }, limits: { post: 0 }, intervalMinutes: 15 }, actor);
  db.close(); db = openOfflineStore(file, initial);
  assert.equal(db.read().enabled, false);
  assert.equal(db.read().tools.publish, false);
  assert.equal(db.read().tools.like, true);
  assert.equal(db.read().limits.post, 0);
  assert.equal(db.read().limits.comment, 25);
  assert.equal(db.read().accessPaused, true);
  assert.equal(db.read().writePaused, true);
  assert.equal(db.read().used.post, 2);
  assert.equal(db.read().audit.length, 1);
  assert.deepEqual(JSON.parse(db.read().audit[0].record.content), { enabled: false, tools: { publish: false }, limits: { post: 0 }, intervalMinutes: 15 });
});

test('额度重置和两层恢复相互独立，并记录操作者及暂停范围', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { reads: 3, writes: 3, accessPaused: true, writePaused: true,
    probe: 'manual_only', notices: [{ layer: 'access', cause: 'network_unavailable', operationId: 'read-pause-1' }],
    readOutcomes: { 'read-pause-1': 'network_unavailable' },
    ledger: { day: '2026-11-07', used: { post: 3, comment: 8, like: 9 }, reservations: { x: 'post' } }, audit: [] });
  assert.equal(typeof admin.resetOfflineQuota, 'function');
  assert.equal(typeof admin.restoreOfflinePause, 'function');
  const actor = { operator: '123', source: 'admin_script', target: '123', time: 1000, auditId: 'admin1', reason: 'network' };
  admin.resetOfflineQuota(db, 'post', actor);
  assert.deepEqual(db.read().ledger.used, { post: 0, comment: 8, like: 9 });
  assert.equal(db.read().accessPaused, true);
  assert.equal(db.read().writePaused, true);
  admin.restoreOfflinePause(db, 'access', { ...actor, auditId: 'admin2', reason: 'captcha' });
  assert.equal(db.read().accessPaused, false);
  assert.equal(db.read().writePaused, true);
  assert.equal(db.read().ledger.used.comment, 8);
  assert.equal(db.read().audit[1].record.operator, '123');
  assert.equal(db.read().audit[1].record.pauseScope, 'both');
  assert.equal(db.read().audit[1].record.reason, '');
  assert.deepEqual(JSON.parse(db.read().audit[1].record.content), {
    selection: 'access', pauseReasons: { access: 'unknown' },
  });
  assert.throws(() => admin.restoreOfflinePause(db, 'write', { ...actor, auditId: 'admin2' }));
  assert.equal(db.read().writePaused, true);
});

test('经验证的暂停周期原因胜过管理员 reason，且不采信任意旧消息', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const reasons = { access: 'captcha', write: 'network_unavailable' };
  db = openOfflineStore(join(dir, 'state.db'), { reads: 3, writes: 3, accessPaused: true, writePaused: true,
    pauseCycles: { access: { id: '01234567-89ab-4cde-8123-0123456789ab', operationId: 'trusted-read', cause: 'captcha' },
      write: { id: '11234567-89ab-4cde-8123-0123456789ab', operationId: 'trusted-write', cause: 'network_unavailable' } },
    notices: [{ layer: 'access', cause: 'SECRET arbitrary text', operationId: 'old' }], audit: [] });
  admin.restoreOfflinePause(db, 'both', { operator: '123', source: 'admin_script', target: '123', time: 2000,
    auditId: 'restore-bound', reason: 'forged secret reason' });
  const record = db.read().audit.find((entry) => entry.id === 'restore-bound').record;
  assert.equal(record.reason, 'network');
  assert.deepEqual(JSON.parse(record.content), { selection: 'both', pauseReasons: reasons });
  assert.equal(JSON.stringify(record).includes('SECRET'), false);
  assert.equal(JSON.stringify(record).includes('forged'), false);
});

test('没有当前暂停周期 ID 时 access、write、both 的恢复原因均为 unknown', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const cases = [
    { layer: 'access', accessPaused: true, writePaused: false, notices: [{ layer: 'access', cause: 'captcha', operationId: 'a1' }], readOutcomes: { a1: 'captcha' },
      audit: [
        { id: 'prior-restore', record: { action: 'restore', content: JSON.stringify({ selection: 'access' }), time: 500 } },
        { id: 'read:a1', record: { source: 'qq', action: 'read_posts', result: 'failure', reason: 'captcha', time: 600 } },
      ], expected: { access: 'unknown' }, auditReason: '' },
    { layer: 'write', accessPaused: false, writePaused: true, notices: [{ layer: 'write', cause: 'failure', operationId: 'w1' }], outcomes: { w1: 'failure' }, expected: { write: 'unknown' }, auditReason: '' },
    { layer: 'both', accessPaused: true, writePaused: true,
      notices: [{ layer: 'access', cause: 'captcha', operationId: 'a2' }, { layer: 'write', cause: 'failure', operationId: 'w2' }],
      readOutcomes: { a2: 'captcha' }, outcomes: { w2: 'failure' }, expected: { access: 'unknown', write: 'unknown' }, auditReason: '' },
  ];
  for (const [index, scenario] of cases.entries()) {
    db?.close();
    db = openOfflineStore(join(dir, `state-${index}.db`), { reads: 3, writes: 3, probe: 'manual_only',
      accessPaused: scenario.accessPaused, writePaused: scenario.writePaused,
      notices: scenario.notices, readOutcomes: scenario.readOutcomes, outcomes: scenario.outcomes, audit: scenario.audit ?? [] });
    admin.restoreOfflinePause(db, scenario.layer, { operator: '123', source: 'admin_script', target: '123',
      time: 2000 + index, auditId: `restore-${index}`, reason: 'network' });
    const record = db.read().audit.find((entry) => entry.id === `restore-${index}`).record;
    assert.equal(record.reason, scenario.auditReason);
    assert.deepEqual(JSON.parse(record.content), { selection: scenario.layer, pauseReasons: scenario.expected });
  }
});

test('原因缺失、通知损坏或无法绑定当前暂停周期时审计明确为 unknown', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const cases = [
    { notices: [{ layer: 'access', operationId: 'a1' }], readOutcomes: { a1: 'captcha' } },
    { notices: [{ layer: 'access', cause: 'captcha', operationId: 'stale' }], readOutcomes: { other: 'captcha' } },
    { notices: [{ layer: 'access', cause: 'captcha', operationId: 'a2' }], readOutcomes: { a2: 'captcha' },
      audit: [{ id: 'prior-restore', record: { action: 'restore', content: JSON.stringify({ selection: 'access' }), time: 2000 } }] },
    { notices: [{ layer: 'access', cause: 'captcha', operationId: 'a3' }], readOutcomes: { a3: 'captcha' },
      audit: [
        { id: 'restore-intent', record: { action: 'restore', result: 'unknown', content: JSON.stringify({ selection: 'access', phase: 'intent' }), time: 2000 } },
        { id: 'read:a3', record: { source: 'qq', action: 'read_posts', result: 'failure', reason: 'captcha', time: 3000 } },
      ] },
    { notices: null, readOutcomes: { a1: 'captcha' } },
  ];
  for (const [index, fields] of cases.entries()) {
    db?.close();
    db = openOfflineStore(join(dir, `state-${index}.db`), { reads: 3, writes: 0, accessPaused: true,
      writePaused: false, ...fields, audit: fields.audit ?? [] });
    admin.restoreOfflinePause(db, 'access', { operator: '123', source: 'admin_script', target: '123',
      time: 3000 + index, auditId: `unknown-${index}`, reason: 'captcha' });
    const record = db.read().audit.find((entry) => entry.id === `unknown-${index}`).record;
    assert.equal(record.reason, '');
    assert.deepEqual(JSON.parse(record.content), { selection: 'access', pauseReasons: { access: 'unknown' } });
    assert.equal(db.read().accessPaused, false);
  }
});

test('探测通知中的自由文本不进入恢复审计，敏感内容保持隔离', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const secret = 'Cookie: qzonetoken=notice-secret';
  db = openOfflineStore(join(dir, 'state.db'), { reads: 3, writes: 0, accessPaused: true, writePaused: false,
    probe: 'manual_only', probeId: 'probe-1', probeFailureReason: secret,
    notices: [
      { layer: 'access', cause: 'captcha', operationId: 'a1' },
      { layer: 'access', cause: 'probe_failed', reason: secret, operationId: 'probe-1' },
    ], readOutcomes: { a1: 'captcha' }, audit: [] });
  admin.restoreOfflinePause(db, 'access', { operator: '123', source: 'admin_script', target: '123',
    time: 4000, auditId: 'safe-reason', reason: secret });
  const audit = JSON.stringify(db.read().audit[0]);
  assert.equal(audit.includes(secret), false);
  assert.equal(audit.includes('notice-secret'), false);
  assert.equal(db.read().audit[0].record.reason, '');
  assert.deepEqual(JSON.parse(db.read().audit[0].record.content), {
    selection: 'access', pauseReasons: { access: 'unknown' },
  });
});

test('管理审计缺失或保存失败时，不得保存配置或解除暂停', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    reads: 3, writes: 3, accessPaused: true, writePaused: true, probe: 'manual_only', tools: {}, limits: {},
    activeStart: 420, activeEnd: 1380, audit: null });
  const actor = { operator: '123', source: 'admin_console', target: '123', time: 1000, auditId: 'x' };
  assert.throws(() => admin.configureOfflineQzone(db, { enabled: false }, actor));
  assert.equal(db.read().enabled, true);
  assert.throws(() => admin.restoreOfflinePause(db, 'both', actor));
  assert.equal(db.read().accessPaused, true);
  assert.equal(db.read().writePaused, true);
});

test('两层暂停原因均未知时不能把恢复原因伪记成 other', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-admin-reason-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { reads: 3, writes: 3, accessPaused: true, writePaused: true, audit: [] });
  admin.restoreOfflinePause(db, 'both', { operator: '123', source: 'admin_console', target: '123', time: 1000, auditId: 'restore-unknown' });
  assert.equal(db.read().audit[0].record.reason, '');
});

test('真实离线结算产生的暂停周期跨重启保留，并用于恢复审计', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-cycle-e2e-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'state.db');
  db = openOfflineStore(file, { reads: 0, writes: 0, accessPaused: false, writePaused: false,
    readAttempts: { r1: true }, readOutcomes: {}, notices: [], audit: [] });
  settleOfflineRead(db, 'r1', 'captcha', 1000);
  const cycle = db.read().pauseCycles.access;
  db.close(); db = openOfflineStore(file, {});
  assert.deepEqual(db.read().pauseCycles.access, cycle);
  admin.restoreOfflinePause(db, 'access', { operator: '123', source: 'admin_console', target: '123', time: 2000, auditId: 'restore-e2e' });
  const state = db.read();
  assert.equal(state.pauseCycles.access, null);
  assert.equal(JSON.parse(state.audit[0].record.content).pauseReasons.access, 'captcha');
});

test('旧版不透明 operationId 的暂停周期保留可信结构化原因', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-cycle-legacy-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { reads: 0, writes: 0, accessPaused: false, writePaused: false,
    readAttempts: { 'r.1': true }, readOutcomes: {}, notices: [], audit: [] });
  settleOfflineRead(db, 'r.1', 'captcha', 1000);
  admin.restoreOfflinePause(db, 'access', { operator: '123', source: 'admin_console', target: '123', time: 2000, auditId: 'restore-legacy' });
  assert.equal(JSON.parse(db.read().audit[0].record.content).pauseReasons.access, 'captcha');
});
