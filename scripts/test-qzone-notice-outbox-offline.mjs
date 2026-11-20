import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import * as outbox from '../src/core/qzone-notice-outbox-offline.mjs';
import { reserveWrite } from '../src/core/qzone-policy-offline.mjs';
import { settleOfflineWrite } from '../src/core/qzone-settlement-offline.mjs';

function memoryStore(state) {
  return {
    read: () => state,
    update(fn) { state = fn(state); return state; },
  };
}

test('真实 reservation 和三次 settlement 产生的旧格式 operationId 可由 outbox 领取且保持原样', () => {
  const day = '2026-11-09';
  const ledger = { day, used: { post: 0, comment: 0, like: 0 }, reservations: {} };
  const reserved = reserveWrite(ledger, { day, kind: 'comment', limit: 3, id: 'op.1' });
  assert.equal(reserved.allowed, true);
  const store = memoryStore({ reads: 0, writes: 0, accessPaused: false, writePaused: false,
    ledger: reserved.state, outcomes: {}, notices: [] });

  for (let attempt = 0; attempt < 3; attempt++) {
    const id = `op.${attempt + 1}`;
    if (attempt > 0) {
      const nextLedger = reserveWrite(store.read().ledger, { day, kind: 'comment', limit: 3, id });
      assert.equal(nextLedger.allowed, true);
      store.update((state) => ({ ...state, ledger: nextLedger.state }));
    }
    settleOfflineWrite(store, id, 'failure', 1000 + attempt);
  }

  const notice = store.read().notices.find((item) => item.layer === 'write');
  assert.equal(notice.operationId, 'op.3');
  assert.equal(outbox.claimOfflineNotice(store, store.read().notices.indexOf(notice), 'attempt1').claimed, true);
  assert.equal(notice.operationId, 'op.3');
});

test('通知先持久化领取，明确成功才标记已发送', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-notice-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'state.db');
  db = openOfflineStore(file, { notices: [{ layer: 'write', cause: 'failure', operationId: 'op1' }] });
  assert.equal(typeof outbox.claimOfflineNotice, 'function');
  assert.equal(outbox.claimOfflineNotice(db, 0, 'attempt1').claimed, true);
  db.close(); db = openOfflineStore(file, { notices: [] });
  assert.equal(outbox.claimOfflineNotice(db, 0, 'attempt2').claimed, false);
  assert.throws(() => outbox.finishOfflineNotice(db, 0, 'attempt2', 'success'));
  outbox.finishOfflineNotice(db, 0, 'attempt1', 'success');
  assert.equal(db.read().notices[0].delivery, 'sent');
  assert.equal(outbox.claimOfflineNotice(db, 0, 'attempt3').claimed, false);
});

test('明确失败可以重新尝试，结果未知不自动重发', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-notice-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { notices: [{ layer: 'access', cause: 'failure', operationId: 'op1' }] });
  outbox.claimOfflineNotice(db, 0, 'attempt1');
  outbox.finishOfflineNotice(db, 0, 'attempt1', 'failure');
  assert.equal(outbox.claimOfflineNotice(db, 0, 'attempt2').claimed, true);
  outbox.finishOfflineNotice(db, 0, 'attempt2', 'unknown');
  assert.equal(db.read().notices[0].delivery, 'unknown');
  assert.equal(outbox.claimOfflineNotice(db, 0, 'attempt3').claimed, false);
});

test('进程中断后的领取状态只能在确认独占后转为未知，不能直接重发', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-notice-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { notices: [{ layer: 'write', cause: 'failure', operationId: 'op1' }] });
  outbox.claimOfflineNotice(db, 0, 'attempt1');
  assert.equal(typeof outbox.recoverOfflineNotice, 'function');
  assert.throws(() => outbox.recoverOfflineNotice(db, 0, false));
  assert.equal(outbox.recoverOfflineNotice(db, 0, true).recovered, true);
  assert.equal(db.read().notices[0].delivery, 'unknown');
  assert.equal(outbox.claimOfflineNotice(db, 0, 'attempt2').claimed, false);
  assert.throws(() => outbox.finishOfflineNotice(db, 0, 'attempt1', 'success'));
});

test('重试领取令牌不能重复使用，迟到的旧结果不能结束新领取', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-notice-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { notices: [{ layer: 'access', cause: 'failure', operationId: 'op1' }] });
  outbox.claimOfflineNotice(db, 0, 'first');
  outbox.finishOfflineNotice(db, 0, 'first', 'failure');
  outbox.claimOfflineNotice(db, 0, 'second');
  outbox.finishOfflineNotice(db, 0, 'second', 'failure');
  assert.throws(() => outbox.claimOfflineNotice(db, 0, 'first'), /reused/);
  assert.equal(outbox.claimOfflineNotice(db, 0, 'third').claimed, true);
  assert.throws(() => outbox.finishOfflineNotice(db, 0, 'first', 'success'), /stale/);
  assert.equal(db.read().notices[0].delivery, 'claimed');
});
