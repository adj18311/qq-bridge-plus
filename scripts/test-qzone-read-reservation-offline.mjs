import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import * as read from '../src/core/qzone-read-reservation-offline.mjs';

test('主动读取同一机会最多一次，写暂停下降频，明确查看请求不受主动预算限制', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-read-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-07T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: true, tools: { read_posts: true }, readAttempts: {}, readOutcomes: {},
    browseDay: '2026-11-07', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380 });
  assert.equal(typeof read.reserveOfflineRead, 'function');
  const req = { id: 'r1', tool: 'read_posts', source: 'proactive', opportunity: 'turn1', now, activeTime: true };
  assert.equal(read.reserveOfflineRead(db, req).allowed, true);
  assert.equal(read.reserveOfflineRead(db, { ...req, id: 'r2', now: now + 3600000 }).allowed, false);
  assert.equal(read.reserveOfflineRead(db, { ...req, id: 'r3', opportunity: 'turn2', now: now + 3599999 }).allowed, false);
  assert.equal(read.reserveOfflineRead(db, { ...req, id: 'r4', source: 'requested', activeTime: false }).allowed, true);
  assert.equal(db.read().todayBrowses, 1);
  assert.equal(db.read().readAttempts.r4, true);
  db.update((s) => ({ ...s, enabled: false }));
  assert.equal(read.reserveOfflineRead(db, { ...req, id: 'r5', source: 'requested' }).allowed, false);
});

test('读取预留与审计意图共同提交，审计失败不消耗主动机会', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-read-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-07T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, tools: { read_posts: true }, readAttempts: {}, readOutcomes: {},
    browseDay: '2026-11-07', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380, audit: null });
  assert.equal(typeof read.reserveAuditedOfflineRead, 'function');
  const req = { id: 'r1', tool: 'read_posts', source: 'proactive', opportunity: 'turn1', target: '123', now, activeTime: true };
  const intent = { time: now, source: 'patrol', action: 'read_posts', target: '123', content: '', result: 'unknown' };
  assert.throws(() => read.reserveAuditedOfflineRead(db, req, intent));
  assert.equal(db.read().todayBrowses, 0);
  assert.equal(Object.hasOwn(db.read().readAttempts, 'r1'), false);
  db.update((s) => ({ ...s, audit: [] }));
  assert.throws(() => read.reserveAuditedOfflineRead(db, req, { ...intent, target: '456' }));
  assert.equal(read.reserveAuditedOfflineRead(db, req, intent).allowed, true);
  assert.equal(db.read().audit[0].id, 'read_intent_r1');
});

test('主动读取时段从可信配置计算，不接受请求伪造 activeTime', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-read-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-07T16:30:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, tools: { read_posts: true }, readAttempts: {}, readOutcomes: {},
    browseDay: '2026-11-08', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380 });
  const req = { id: 'r1', tool: 'read_posts', source: 'proactive', opportunity: 'turn1', now, activeTime: true };
  assert.equal(read.reserveOfflineRead(db, req).allowed, false);
  assert.equal(read.reserveOfflineRead(db, { ...req, activeTime: false }).allowed, false);
  assert.equal(db.read().todayBrowses, 0);
});

test('读取意图通过校验后即使原对象变化，持久化目标仍是已校验快照', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-read-snapshot-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-07T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, tools: { read_posts: true }, readAttempts: {}, readOutcomes: {},
    browseDay: '2026-11-07', todayBrowses: 0, usedOpportunities: {}, audit: [] });
  const req = { id: 'r1', tool: 'read_posts', source: 'requested', target: '123', opportunity: 'op1', now, activeTime: false };
  const intent = { time: now, source: 'qq', action: 'read_posts', target: '123', content: '', result: 'unknown' };
  const store = { update(fn) { intent.target = '456'; req.source = 'proactive'; return db.update(fn); } };
  assert.equal(read.reserveAuditedOfflineRead(store, req, intent).allowed, true);
  assert.equal(db.read().audit[0].record.target, '123');
  assert.equal(db.read().todayBrowses, 0);
});
