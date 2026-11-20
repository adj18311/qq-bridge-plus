import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { runQzoneHealthProbe } from '../src/core/qzone-health-probe-runtime.mjs';
import { dispatchNotice } from '../src/core/qzone-notice-runtime.mjs';
import { createQzoneOwnerNoticeSender } from '../src/core/qzone-owner-notice-adapter.mjs';

test('只读模拟探测失败后产生持久通知，通知明确成功只投递一次', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-probe-notice-')); let store;
  t.after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'state.sqlite');
  const now = 1000 + 86400000;
  store = openOfflineStore(file, { botQq: '456', selfId: '456', enabled: true,
    accessPaused: true, writePaused: true, pausedAt: 1000, probe: 'waiting', notices: [], audit: [] });
  let reads = 0;
  const probe = await runQzoneHealthProbe({ store, now: () => now, adminQq: '123', botQq: '456',
    serviceReady: () => true, activeTime: () => true, readOwnSpace: async ({ targetQq }) => {
      reads++; assert.equal(targetQq, '123'); return { status: 'gateway_unavailable' };
    } });
  assert.equal(probe.status, 'failed');
  assert.equal(reads, 1);
  assert.equal(store.read().probe, 'manual_only');
  assert.equal(store.read().notices[0].cause, 'probe_failed');
  let sends = 0;
  const sender = async text => { sends++; assert.match(text, /管理员/); return 'success'; };
  assert.equal((await dispatchNotice(store, 0, { token: 'first', sender })).status, 'sent');
  assert.equal((await dispatchNotice(store, 0, { token: 'second', sender })).status, 'not_claimed');
  assert.equal(sends, 1);
  assert.equal(store.read().notices[0].delivery, 'sent');
});

test('真实回执适配契约下失败语义不明时保守封存，不因回执异常盲目重复通知', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-owner-notice-')); let store;
  t.after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });
  store = openOfflineStore(join(dir, 'state.sqlite'), { notices: [{ layer: 'write', cause: 'failure', operationId: 'fixture' }] });
  let calls = 0;
  const sender = createQzoneOwnerNoticeSender(async () => { calls++; return { outcome: 'failed', code: 'synthetic-secret' }; });
  assert.equal((await dispatchNotice(store, 0, { token: 'first', sender })).status, 'unknown');
  assert.equal((await dispatchNotice(store, 0, { token: 'second', sender })).status, 'not_claimed');
  assert.equal(calls, 1);
  assert.equal(store.read().notices[0].delivery, 'unknown');
  assert.doesNotMatch(JSON.stringify(store.read()), /synthetic-secret/);
});
