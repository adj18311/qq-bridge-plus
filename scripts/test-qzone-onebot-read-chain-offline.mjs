import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import { simulateOfflineFriendRead } from '../src/core/qzone-simulation-offline.mjs';
import { buildQzoneOnebotReadRequest } from '../src/core/qzone-onebot-contract-offline.mjs';
import { projectQzoneOnebotMsgList } from '../src/core/qzone-onebot-projection-offline.mjs';
import { createQzoneOnebotReadTransport } from '../src/core/qzone-onebot-read-transport.mjs';
import { verifyOfflineQzoneFriend } from '../src/core/qzone-friend-proof-offline.mjs';

test('读取链把明确目标构造成 OneBot 请求，投影并只放行七天内内容', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-onebot-chain-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-08T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, tools: { read_posts: true },
    readAttempts: {}, readOutcomes: {}, notices: [], browseDay: '2026-11-08', todayBrowses: 0,
    lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380, audit: [] });
  const request = { id: 'r1', now, tool: 'read_posts', source: 'requested', target: '123', activeTime: false };
  let calls = 0;
  const fake = async () => {
    calls++;
    assert.deepEqual(buildQzoneOnebotReadRequest('get_qzone_msg_list', { target_uin: '123', num: 2 }),
      { action: 'get_qzone_msg_list', params: { target_uin: 123, pos: 0, num: 2 } });
    return projectQzoneOnebotMsgList('123', { status: 'ok', retcode: 0, data: { total: 2, msglist: [
      { tid: 'new1', time: now / 1000 - 2, content: 'recent', cookie: 'secret-fixture' },
      { tid: 'old1', time: now / 1000 - 8 * 86400, content: 'old-private' },
    ] } }, now);
  };
  const result = await simulateOfflineFriendRead(db, request, { friend: true, author: '123' }, fake);
  assert.deepEqual(result.posts, [{ author: '123', id: 'new1', time: now - 2000, content: 'recent' }]);
  assert.equal(JSON.stringify(result).includes('secret-fixture'), false);
  assert.equal(JSON.stringify(result).includes('old-private'), false);
  assert.equal(db.read().audit.find((x) => x.id === 'read:r1').record.result, 'success');
  assert.equal(calls, 1);
});

test('模拟好友核验失败时不启动后续空间读取', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-onebot-chain-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-08T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, tools: { read_posts: true },
    readAttempts: {}, readOutcomes: {}, notices: [], browseDay: '2026-11-08', todayBrowses: 0,
    lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380, audit: [] });
  const proof = verifyOfflineQzoneFriend({ trustedCurrentRead: true, targetQq: 123,
    envelope: { status: 'ok', retcode: 0, data: [{ user_id: 456 }] } });
  assert.deepEqual(proof, { trustedStatus: 'trusted', friend: false });
  const req = { id: 'r1', now, tool: 'read_posts', source: 'requested', target: '123', activeTime: false };
  let calls = 0;
  await assert.rejects(() => simulateOfflineFriendRead(db, req, { friend: proof.friend, author: '123' }, async () => { calls++; return []; }));
  assert.equal(calls, 0);
  assert.deepEqual(db.read().readAttempts, {});
});

test('注入的虚拟 HTTP 传输完成读取到过滤和审计，不接触真实网络', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-onebot-chain-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-08T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, tools: { read_posts: true },
    readAttempts: {}, readOutcomes: {}, notices: [], browseDay: '2026-11-08', todayBrowses: 0,
    lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380, audit: [] });
  let calls = 0;
  const transport = createQzoneOnebotReadTransport({ origin: 'http://127.0.0.1:12345', fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:12345/get_qzone_msg_list');
    assert.deepEqual(JSON.parse(init.body), { target_uin: 123, pos: 0, num: 20 });
    return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { total: 1,
      msglist: [{ tid: 'post-1', time: now / 1000 - 5, content: 'hello', token: 'hidden' }] } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const request = { id: 'r1', now, tool: 'read_posts', source: 'requested', target: '123', activeTime: false };
  const result = await simulateOfflineFriendRead(db, request, { friend: true, author: '123' }, async () => {
    const response = await transport.get_qzone_msg_list({ target_uin: '123' });
    if (response.kind !== 'trusted-envelope') return null;
    return projectQzoneOnebotMsgList('123', response.envelope, now);
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.posts, [{ author: '123', id: 'post-1', time: now - 5000, content: 'hello' }]);
  assert.equal(JSON.stringify(result).includes('hidden'), false);
  assert.equal(db.read().audit.find((x) => x.id === 'read:r1').record.result, 'success');
});
