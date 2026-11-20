import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import * as settlement from '../src/core/qzone-settlement-offline.mjs';
import { formatAuditRecord } from '../src/core/qzone-audit-offline.mjs';

test('连续三次已预留写入明确失败后只产生一次暂停通知，重复结果不计数', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-settle-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const path = join(dir, 'state.db');
  const initial = { reads: 0, writes: 0, accessPaused: false, writePaused: false,
    ledger: { day: '2026-11-07', used: { post: 0, comment: 3, like: 0 }, reservations: { a: 'comment', b: 'comment', c: 'comment' } }, outcomes: {}, notices: [] };
  db = openOfflineStore(path, initial);
  assert.equal(typeof settlement.settleOfflineWrite, 'function');
  assert.equal(settlement.settleOfflineWrite(db, 'a', 'failure').applied, true);
  assert.equal(settlement.settleOfflineWrite(db, 'a', 'failure').applied, false);
  settlement.settleOfflineWrite(db, 'b', 'failure');
  settlement.settleOfflineWrite(db, 'c', 'failure');
  assert.equal(db.read().writePaused, true);
  assert.match(db.read().pauseCycles?.write?.id ?? '', /^[0-9a-f-]{36}$/i);
  assert.equal(db.read().pauseCycles.write.operationId, 'c');
  assert.equal(db.read().pauseCycles.write.cause, 'failure');
  assert.equal(db.read().writes, 3);
  assert.equal(db.read().notices.length, 1);
  assert.equal(db.read().ledger.used.comment, 3);
  db.close(); db = openOfflineStore(path, initial);
  assert.equal(db.read().notices.length, 1);
  assert.equal(db.read().writePaused, true);
});

test('未知结果不增加失败计数、不退还额度，未预留或冲突结果拒绝', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-settle-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { reads: 0, writes: 2, accessPaused: false, writePaused: false,
    ledger: { day: '2026-11-07', used: { post: 1, comment: 0, like: 0 }, reservations: { a: 'post' } }, outcomes: {}, notices: [] });
  assert.equal(settlement.settleOfflineWrite(db, 'a', 'unknown').applied, true);
  assert.equal(db.read().writes, 2);
  assert.equal(db.read().ledger.used.post, 1);
  assert.throws(() => settlement.settleOfflineWrite(db, 'missing', 'success'));
  assert.throws(() => settlement.settleOfflineWrite(db, 'a', 'success'));
});

test('验证码等明确故障直接全暂停并保留通知', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-settle-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { reads: 0, writes: 0, accessPaused: false, writePaused: false,
    ledger: { day: '2026-11-07', used: { post: 1, comment: 0, like: 0 }, reservations: { a: 'post' } }, outcomes: {}, notices: [] });
  settlement.settleOfflineWrite(db, 'a', 'captcha');
  assert.equal(db.read().accessPaused, true);
  assert.equal(db.read().pauseCycles.access.operationId, 'a');
  assert.equal(db.read().pauseCycles.access.cause, 'captcha');
  assert.equal(db.read().notices[0].layer, 'access');
});

test('读操作单独计数：隐私拒绝不计数，连续三次失败产生全暂停事件', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-settle-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { reads: 0, writes: 2, accessPaused: false, writePaused: false,
    readAttempts: { a: true, b: true, c: true, d: true }, readOutcomes: {}, notices: [] });
  assert.equal(typeof settlement.settleOfflineRead, 'function');
  settlement.settleOfflineRead(db, 'a', 'not_accessible');
  assert.equal(db.read().reads, 0);
  for (const id of ['b', 'c', 'd']) settlement.settleOfflineRead(db, id, 'failure');
  assert.equal(db.read().accessPaused, true);
  assert.equal(db.read().writes, 2);
  assert.equal(db.read().notices.length, 1);
  assert.equal(db.read().notices[0].layer, 'access');
  assert.equal(settlement.settleOfflineRead(db, 'd', 'failure').applied, false);
  assert.throws(() => settlement.settleOfflineRead(db, 'missing', 'success'));
});

test('首次进入全暂停时持久化暂停时间和等待状态，以便只探测一次', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-settle-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { reads: 0, writes: 0, accessPaused: false, writePaused: false,
    readAttempts: { a: true }, readOutcomes: {}, notices: [] });
  settlement.settleOfflineRead(db, 'a', 'captcha', 123456);
  assert.equal(db.read().pausedAt, 123456);
  assert.equal(db.read().probe, 'waiting');
});

test('写入结果与审计在同一事务提交，审计无效时结算整体回滚', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-settle-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { reads: 0, writes: 2, accessPaused: false, writePaused: false,
    ledger: { day: '2026-11-07', used: { post: 1, comment: 0, like: 0 }, reservations: { a: 'post' } }, outcomes: {}, notices: [], audit: [] });
  assert.equal(typeof settlement.settleAuditedOfflineWrite, 'function');
  const input = { time: 1000, source: 'qq', action: 'publish', target: '123', content: 'hello', result: 'failure', reason: 'network' };
  db.update((s) => ({ ...s, audit: [{ id: 'intent_a', record: formatAuditRecord({ ...input, result: 'unknown', reason: '' }) }] }));
  assert.throws(() => settlement.settleAuditedOfflineWrite(db, 'a', 'failure', { ...input, reason: 'bad raw secret' }, 1000));
  assert.equal(db.read().writes, 2);
  assert.equal(db.read().writePaused, false);
  assert.equal(db.read().audit.length, 1);
  assert.equal(settlement.settleAuditedOfflineWrite(db, 'a', 'failure', input, 1000).applied, true);
  assert.equal(db.read().writePaused, true);
  assert.equal(db.read().audit.length, 2);
  assert.equal(db.read().notices.length, 1);
  assert.equal(settlement.settleAuditedOfflineWrite(db, 'a', 'failure', input, 1000).applied, false);
  assert.equal(db.read().audit.length, 2);
});

test('读取结果与审计共同结算，审计结果冲突不得改变熔断状态', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-settle-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { reads: 2, writes: 0, accessPaused: false, writePaused: false,
    readAttempts: { a: true }, readOutcomes: {}, notices: [], audit: [] });
  assert.equal(typeof settlement.settleAuditedOfflineRead, 'function');
  const record = { time: 1000, source: 'qq', action: 'read_posts', target: '123', content: '', result: 'failure', reason: 'network' };
  db.update((s) => ({ ...s, audit: [{ id: 'read_intent_a', record: formatAuditRecord({ ...record, result: 'unknown', reason: '' }) }] }));
  assert.throws(() => settlement.settleAuditedOfflineRead(db, 'a', 'failure', { ...record, result: 'success' }, 1000));
  assert.equal(db.read().reads, 2);
  settlement.settleAuditedOfflineRead(db, 'a', 'failure', record, 1000);
  assert.equal(db.read().accessPaused, true);
  assert.equal(db.read().audit.length, 2);
  assert.equal(db.read().notices.length, 1);
});

test('审计的时间和特定故障原因必须匹配结算事实', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-settle-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { reads: 0, writes: 0, accessPaused: false, writePaused: false,
    ledger: { day: '2026-11-07', used: { post: 1, comment: 0, like: 0 }, reservations: { a: 'post' } }, outcomes: {}, notices: [], audit: [] });
  const record = { time: 1000, source: 'qq', action: 'publish', target: '123', content: '', result: 'failure', reason: 'captcha' };
  db.update((s) => ({ ...s, audit: [{ id: 'intent_a', record: formatAuditRecord({ ...record, result: 'unknown', reason: '' }) }] }));
  assert.throws(() => settlement.settleAuditedOfflineWrite(db, 'a', 'captcha', { ...record, time: 999 }, 1000));
  assert.throws(() => settlement.settleAuditedOfflineWrite(db, 'a', 'captcha', { ...record, reason: 'network' }, 1000));
  assert.throws(() => settlement.settleAuditedOfflineWrite(db, 'a', 'failure', { ...record }, 1000));
  assert.equal(db.read().audit.length, 1);
  assert.equal(db.read().accessPaused, false);
  settlement.settleAuditedOfflineWrite(db, 'a', 'captcha', record, 1000);
  assert.equal(db.read().audit.find((x) => x.id === 'write:a').record.reason, 'captcha');
});

test('终态审计必须与既有意图中的目标和内容一致', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-settle-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const intent = { time: 1000, source: 'qq', action: 'publish', target: '123', content: 'hello', result: 'unknown' };
  db = openOfflineStore(join(dir, 'state.db'), { reads: 0, writes: 0, accessPaused: false, writePaused: false,
    ledger: { day: '2026-11-07', used: { post: 1, comment: 0, like: 0 }, reservations: { a: 'post' } }, outcomes: {}, notices: [],
    audit: [{ id: 'intent_a', record: formatAuditRecord(intent) }] });
  const result = { ...intent, result: 'success' };
  assert.throws(() => settlement.settleAuditedOfflineWrite(db, 'a', 'success', { ...result, target: '456' }, 1000));
  assert.throws(() => settlement.settleAuditedOfflineWrite(db, 'a', 'success', { ...result, content: 'other' }, 1000));
  assert.equal(Object.hasOwn(db.read().outcomes, 'a'), false);
  settlement.settleAuditedOfflineWrite(db, 'a', 'success', result, 1000);
  assert.equal(db.read().outcomes.a, 'success');
});

test('不同的双边遮蔽正文均 fail closed，不结算或持久化原文', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-settle-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'state.db');
  const intent = { time: 1000, source: 'qq', action: 'publish', target: '123', content: 'Cookie: qzonetoken=reserve-secret', result: 'unknown' };
  db = openOfflineStore(file, { reads: 0, writes: 0, accessPaused: false, writePaused: false,
    ledger: { day: '2026-11-07', used: { post: 1, comment: 0, like: 0 }, reservations: { a: 'post' } }, outcomes: {}, notices: [], audit: [],
    selfId: '123' });
  db.update((state) => ({ ...state, audit: [{ id: 'intent_a', record: formatAuditRecord(intent) }] }));
  const changedBodies = [
    'Authorization: Bearer settlement-secret',
    'https://example.test/?qzonetoken=another-secret',
  ];
  for (const content of changedBodies) {
    assert.throws(() => settlement.settleAuditedOfflineWrite(db, 'a', 'success', { ...intent, content, result: 'success' }, 1000));
  }
  const result = { ...intent, content: changedBodies[0], result: 'success' };
  for (const change of [{ target: '456' }, { action: 'comment' }, { source: 'patrol' }, { postId: 'p2' }, { commentId: 'c1' }]) {
    assert.throws(() => settlement.settleAuditedOfflineWrite(db, 'a', 'success', { ...result, ...change }, 1000));
  }
  assert.equal(Object.hasOwn(db.read().outcomes, 'a'), false);
  assert.equal(Object.hasOwn(db.read().outcomes, 'a'), false);
  assert.equal(db.read().audit.length, 1);
  const persisted = JSON.stringify(db.read());
  assert.equal(persisted.includes('reserve-secret'), false);
  assert.equal(persisted.includes('settlement-secret'), false);
  const disk = await readFile(file);
  assert.equal(disk.includes(Buffer.from('reserve-secret')), false);
  assert.equal(disk.includes(Buffer.from('settlement-secret')), false);
  assert.equal(db.read().audit.some((entry) => entry.id === 'write:a'), false);
});

test('已遮蔽意图必须拒绝未遮蔽结算正文，反向遮蔽不一致也拒绝', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-settle-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const ordinaryIntent = { time: 1000, source: 'qq', action: 'publish', target: '123', content: 'ordinary', result: 'unknown' };
  db = openOfflineStore(join(dir, 'state.db'), { reads: 0, writes: 0, accessPaused: false, writePaused: false,
    ledger: { day: '2026-11-07', used: { post: 1, comment: 0, like: 0 }, reservations: { a: 'post' } }, outcomes: {}, notices: [],
    audit: [{ id: 'intent_a', record: formatAuditRecord(ordinaryIntent) }] });
  const maskedResult = { ...ordinaryIntent, content: 'qzonetoken=secret', result: 'success' };
  assert.throws(() => settlement.settleAuditedOfflineWrite(db, 'a', 'success', maskedResult, 1000));
  assert.throws(() => settlement.settleAuditedOfflineWrite(db, 'a', 'success', { ...ordinaryIntent, content: 'different', result: 'success' }, 1000));
  assert.equal(Object.hasOwn(db.read().outcomes, 'a'), false);
});

test('不存在原始审计意图时不能进行带审计结算', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-settle-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { reads: 0, writes: 0, accessPaused: false, writePaused: false,
    ledger: { day: '2026-11-07', used: { post: 1, comment: 0, like: 0 }, reservations: { a: 'post' } }, outcomes: {}, notices: [], audit: [] });
  const result = { time: 1000, source: 'qq', action: 'publish', target: '123', content: '', result: 'success' };
  assert.throws(() => settlement.settleAuditedOfflineWrite(db, 'a', 'success', result, 1000));
  assert.equal(Object.hasOwn(db.read().outcomes, 'a'), false);
});
