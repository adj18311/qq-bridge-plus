import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import * as history from '../src/core/qzone-history-grant-offline.mjs';

test('单次授权消费及审计意图一起持久化，不能通过重放原输入再次消费', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-history-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'state.db');
  const initial = { grants: { g1: { requester: '123', author: '123', question: 'q1', postId: 'p1', status: 'ready' } }, audit: [] };
  db = openOfflineStore(file, initial);
  assert.equal(typeof history.consumeStoredHistoryGrant, 'function');
  const request = { requester: '123', author: '123', question: 'q1', postId: 'p1' };
  const intent = { time: 1000, source: 'qq', action: 'read_posts', target: '123', postId: 'p1', content: '', result: 'unknown' };
  assert.equal(history.consumeStoredHistoryGrant(db, 'g1', request, intent).allowed, true);
  db.close(); db = openOfflineStore(file, initial);
  assert.equal(history.consumeStoredHistoryGrant(db, 'g1', request, intent).allowed, false);
  assert.equal(db.read().audit.length, 1);
});

test('授权不匹配或审计状态损坏时不得消费授权', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-history-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { grants: { g1: { requester: '123', author: '123', question: 'q1', postId: null, status: 'ready' } }, audit: null });
  const request = { requester: '123', author: '123', question: 'q1', postId: null };
  const intent = { time: 1000, source: 'qq', action: 'read_posts', target: '123', content: '', result: 'unknown' };
  assert.throws(() => history.consumeStoredHistoryGrant(db, 'g1', request, intent));
  assert.equal(db.read().grants.g1.status, 'ready');
  db.update((s) => ({ ...s, audit: [] }));
  assert.throws(() => history.consumeStoredHistoryGrant(db, 'g1', { ...request, requester: '456' }, intent));
  assert.equal(db.read().grants.g1.status, 'ready');
});

test('单次授权校验后原意图变化，不得改变落盘审计目标', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-grant-snapshot-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { grants: { g1: { requester: '123', author: '123', question: 'q1', postId: 'p1', status: 'ready' } }, audit: [] });
  const request = { requester: '123', author: '123', question: 'q1', postId: 'p1' };
  const intent = { time: 1000, source: 'qq', action: 'read_posts', target: '123', postId: 'p1', content: '', result: 'unknown' };
  const store = { update(fn) { intent.target = '456'; return db.update(fn); } };
  assert.equal(history.consumeStoredHistoryGrant(store, 'g1', request, intent).allowed, true);
  assert.equal(db.read().audit[0].record.target, '123');
});
