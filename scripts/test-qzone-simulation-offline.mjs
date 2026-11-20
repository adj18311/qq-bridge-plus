import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import * as simulator from '../src/core/qzone-simulation-offline.mjs';

test('模拟写链先预留再调用，未知结果保留额度且不会重放', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, selfId: '123', tools: { publish: true }, limits: { post: 3 },
    ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, lastPostAt: null, outcomes: {}, notices: [], audit: [] });
  assert.equal(typeof simulator.simulateOfflinePost, 'function');
  let calls = 0;
  const fake = async () => { calls++; assert.equal(db.read().ledger.used.post, 1); assert.equal(db.read().audit.some((x) => x.id === 'intent_a'), true); return 'unknown'; };
  const req = { id: 'a', now: Date.parse('2026-11-07T00:00:00Z'), audit: { source: 'qq', target: '123', content: 'hello' } };
  assert.equal((await simulator.simulateOfflinePost(db, req, fake)).outcome, 'unknown');
  assert.equal(db.read().ledger.used.post, 1);
  assert.equal(db.read().outcomes.a, 'unknown');
  assert.equal(db.read().audit.length, 2);
  assert.equal(db.read().audit.find((x) => x.id === 'write:a').record.result, 'unknown');
  assert.equal((await simulator.simulateOfflinePost(db, { ...req, now: req.now + 7200000 }, fake)).allowed, false);
  assert.equal(calls, 1);
});

test('停用或持久化失败时不调用模拟网关', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: false, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, selfId: '123', tools: { publish: true }, limits: { post: 3 },
    ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, lastPostAt: null, outcomes: {}, notices: [], audit: [] });
  let calls = 0; const fake = async () => { calls++; return 'success'; };
  const req = { id: 'a', now: Date.parse('2026-11-07T00:00:00Z'), audit: { source: 'qq', target: '123', content: 'hello' } };
  assert.equal((await simulator.simulateOfflinePost(db, req, fake)).allowed, false);
  await assert.rejects(() => simulator.simulateOfflinePost({ update() { throw new Error('disk'); } }, req, fake), /disk/);
  assert.equal(calls, 0);
});

test('预留后派发前若总开关关闭，不调用模拟网关', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, selfId: '123', tools: { publish: true }, limits: { post: 3 },
    ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, lastPostAt: null, outcomes: {}, notices: [], audit: [] });
  let calls = 0; let flipped = false;
  const proxy = { read: () => db.read(), update(fn) { const result = db.update(fn); if (!flipped) { flipped = true; db.update((s) => ({ ...s, enabled: false })); } return result; } };
  const result = await simulator.simulateOfflinePost(proxy, { id: 'a', now: Date.parse('2026-11-07T00:00:00Z'), audit: { source: 'qq', target: '123', content: 'hello' } }, async () => { calls++; return 'success'; });
  assert.equal(result.allowed, false);
  assert.equal(calls, 0);
});

test('审计参数不合法或审计意图写入失败时不调用模拟网关', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, selfId: '123', tools: { publish: true }, limits: { post: 3 },
    ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, lastPostAt: null, outcomes: {}, notices: [], audit: [] });
  let calls = 0;
  const fake = async () => { calls++; return 'success'; };
  const req = { id: 'a', now: Date.parse('2026-11-07T00:00:00Z'), audit: { source: 'qq', target: 'bad', content: 'hello' } };
  await assert.rejects(() => simulator.simulateOfflinePost(db, req, fake));
  assert.equal(db.read().ledger.used.post, 0);
  db.update((s) => ({ ...s, audit: null }));
  await assert.rejects(() => simulator.simulateOfflinePost(db, { ...req, audit: { ...req.audit, target: '123' } }, fake), /invalid audit state/);
  assert.equal(db.read().ledger.used.post, 0);
  assert.equal(calls, 0);
});

test('互动模拟调用链包含原子意图、全局间隔与原子结算审计', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-07T00:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, tools: { comment: true, like: true }, limits: { comment: 25, like: 30 },
    ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, commentTargets: [], likes: [], outcomes: {}, notices: [], audit: [] });
  assert.equal(typeof simulator.simulateOfflineInteraction, 'function');
  let calls = 0;
  const fake = async () => { calls++; assert.equal(db.read().audit.some((x) => x.id === 'intent_a'), true); return 'success'; };
  const req = { id: 'a', now, tool: 'comment', target: '123', postId: 'p1', source: 'qq', audit: { content: 'hello' } };
  assert.equal((await simulator.simulateOfflineInteraction(db, req, fake)).outcome, 'success');
  assert.equal(db.read().audit.find((x) => x.id === 'write:a').record.result, 'success');
  assert.equal((await simulator.simulateOfflineInteraction(db, { ...req, id: 'b', target: '456', now: now + 179999 }, fake)).allowed, false);
  assert.equal(calls, 1);
});

test('读取模拟只返回七天内且指定好友的白名单字段，并完成审计', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-07T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    reads: 0, writes: 0, tools: { read_posts: true }, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-07', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380, audit: [] });
  assert.equal(typeof simulator.simulateOfflineFriendRead, 'function');
  const req = { id: 'r1', now, tool: 'read_posts', source: 'requested', target: '123', activeTime: false };
  let calls = 0;
  const fake = async () => { calls++; return [
    { author: '123', id: 'new', time: now - 1000, content: 'ok', rawResponse: { cookie: 'do-not-return' } },
    { author: '123', id: 'old', time: now - 8 * 86400000, content: 'old-hidden' },
    { author: '456', id: 'other', time: now, content: 'other-hidden' },
  ]; };
  const result = await simulator.simulateOfflineFriendRead(db, req, { friend: true, author: '123' }, fake);
  assert.deepEqual(result.posts.map((x) => x.id), ['new']);
  assert.equal(JSON.stringify(result).includes('hidden'), false);
  assert.equal(JSON.stringify(result).includes('do-not-return'), false);
  assert.equal(db.read().audit.find((x) => x.id === 'read:r1').record.result, 'success');
  assert.equal(calls, 1);
});

test('三次明确写失败只暂停写入，仍允许模拟读取', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-07T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, tools: { like: true, read_posts: true },
    limits: { like: 30 }, ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    commentTargets: [], likes: [], outcomes: {}, notices: [], audit: [], readAttempts: {}, readOutcomes: {},
    browseDay: '2026-11-07', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380 });
  for (let i = 0; i < 3; i++) {
    const req = { id: `f${i}`, now: now + i, tool: 'like', target: '123', postId: `p${i}`, source: 'qq', audit: { content: '' } };
    assert.equal((await simulator.simulateOfflineInteraction(db, req, async () => 'failure')).outcome, 'failure');
  }
  assert.equal(db.read().writePaused, true);
  assert.equal(db.read().accessPaused, false);
  assert.equal(db.read().notices.filter((x) => x.layer === 'write').length, 1);
  const req = { id: 'r', now: now + 10, tool: 'read_posts', source: 'requested', target: '123', activeTime: false };
  assert.equal((await simulator.simulateOfflineFriendRead(db, req, { friend: true, author: '123' }, async () => [])).outcome, 'success');
});

test('模拟读取抛异常不泄漏异常文本，并保留未知结果审计', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-07T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    reads: 0, writes: 0, tools: { read_posts: true }, readAttempts: {}, readOutcomes: {}, notices: [],
    browseDay: '2026-11-07', todayBrowses: 0, lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380, audit: [] });
  const req = { id: 'err', now, tool: 'read_posts', source: 'requested', target: '123', activeTime: false };
  const result = await simulator.simulateOfflineFriendRead(db, req, { friend: true, author: '123' }, async () => { throw new Error('secret-test-value'); });
  assert.equal(result.outcome, 'unknown');
  assert.equal(JSON.stringify(result).includes('secret-test-value'), false);
  assert.equal(JSON.stringify(db.read()).includes('secret-test-value'), false);
  assert.equal(db.read().audit.find((x) => x.id === 'read:err').record.result, 'unknown');
});

test('读取权限关闭后不得调用模拟网关，包括预留后派发前关闭', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-07T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: false, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, tools: { read_posts: true },
    readAttempts: {}, readOutcomes: {}, notices: [], browseDay: '2026-11-07', todayBrowses: 0,
    lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380, audit: [] });
  const req = { id: 'r1', now, tool: 'read_posts', source: 'requested', target: '123', activeTime: false };
  let calls = 0;
  const fake = async () => { calls++; return []; };
  const scope = { friend: true, author: '123' };
  assert.equal((await simulator.simulateOfflineFriendRead(db, req, scope, fake)).allowed, false);
  assert.equal(db.read().audit.length, 0);
  db.update((s) => ({ ...s, readAllowed: true }));
  let flipped = false;
  const proxy = { read: () => db.read(), update(fn) {
    const result = db.update(fn);
    if (!flipped) { flipped = true; db.update((s) => ({ ...s, readAllowed: false })); }
    return result;
  } };
  const result = await simulator.simulateOfflineFriendRead(proxy, req, scope, fake);
  assert.equal(result.allowed, false);
  assert.equal(result.reserved, true);
  assert.equal(db.read().audit.some((entry) => entry.id === 'read_intent_r1'), true);
  assert.equal(calls, 0);
});

test('好友读取范围未确认或目标不匹配时不得预留或调用模拟网关', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-07T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, tools: { read_posts: true },
    readAttempts: {}, readOutcomes: {}, notices: [], browseDay: '2026-11-07', todayBrowses: 0,
    lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380, audit: [] });
  const req = { id: 'r1', now, tool: 'read_posts', source: 'requested', target: '123', activeTime: false };
  let calls = 0;
  const fake = async () => { calls++; return []; };
  await assert.rejects(() => simulator.simulateOfflineFriendRead(db, req, { friend: false, author: '123' }, fake), /trusted friend scope required/);
  await assert.rejects(() => simulator.simulateOfflineFriendRead(db, req, { friend: true, author: '456' }, fake), /trusted friend scope required/);
  assert.equal(calls, 0);
  assert.deepEqual(db.read().readAttempts, {});
  assert.deepEqual(db.read().audit, []);
});

test('模拟读取的明确登录失效立即暂停全部访问并记入审计', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-07T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, tools: { read_posts: true },
    readAttempts: {}, readOutcomes: {}, notices: [], browseDay: '2026-11-07', todayBrowses: 0,
    lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380, audit: [] });
  const req = { id: 'r1', now, tool: 'read_posts', source: 'requested', target: '123', activeTime: false };
  const result = await simulator.simulateOfflineFriendRead(db, req, { friend: true, author: '123' }, async () => ({ outcome: 'login_expired' }));
  assert.equal(result.outcome, 'login_expired');
  assert.deepEqual(result.posts, []);
  assert.equal(db.read().accessPaused, true);
  assert.equal(db.read().notices.filter((x) => x.layer === 'access').length, 1);
  assert.equal(db.read().audit.find((x) => x.id === 'read:r1').record.reason, 'login_expired');
});

test('好友空间权限拒绝不计读取熔断，三次真实读取失败才暂停', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-07T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, tools: { read_posts: true },
    readAttempts: {}, readOutcomes: {}, notices: [], browseDay: '2026-11-07', todayBrowses: 0,
    lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380, audit: [] });
  const scope = { friend: true, author: '123' };
  const request = (id) => ({ id, now, tool: 'read_posts', source: 'requested', target: '123', activeTime: false });
  assert.equal((await simulator.simulateOfflineFriendRead(db, request('denied'), scope, async () => ({ outcome: 'not_accessible' }))).outcome, 'not_accessible');
  assert.equal(db.read().reads, 0);
  assert.equal(db.read().accessPaused, false);
  for (let i = 1; i <= 3; i++) {
    assert.equal((await simulator.simulateOfflineFriendRead(db, request(`failure${i}`), scope, async () => ({ outcome: 'failure' }))).outcome, 'failure');
    assert.equal(db.read().accessPaused, i === 3);
  }
  assert.equal(db.read().notices.filter((x) => x.layer === 'access').length, 1);
});

test('读取期间修改原始请求不能改变经过授权的目标与时间', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-08T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, tools: { read_posts: true },
    readAttempts: {}, readOutcomes: {}, notices: [], browseDay: '2026-11-08', todayBrowses: 0,
    lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380, audit: [] });
  const req = { id: 'r1', now, tool: 'read_posts', source: 'requested', target: '123', activeTime: false };
  const result = await simulator.simulateOfflineFriendRead(db, req, { friend: true, author: '123' }, async () => {
    req.target = '456'; req.now += 8 * 86400000;
    return [{ author: '123', id: 'new', time: now - 1, content: 'ok' },
      { author: '456', id: 'other', time: now, content: 'must-not-return' }];
  });
  assert.deepEqual(result.posts.map((post) => post.id), ['new']);
  assert.equal(db.read().audit.find((item) => item.id === 'read:r1').record.target, '123');
});

test('互动派发后修改原始请求不能让结果结算到另一个操作', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-08T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, tools: { comment: true }, limits: { comment: 25 },
    ledger: { day: '2026-11-08', used: { post: 0, comment: 0, like: 0 }, reservations: {} },
    commentTargets: [], likes: [], outcomes: {}, notices: [], audit: [] });
  const req = { id: 'original', now, tool: 'comment', target: '123', postId: 'post', source: 'qq', audit: { content: 'hello' } };
  const result = await simulator.simulateOfflineInteraction(db, req, async () => {
    req.id = 'different'; req.now += 1000; req.target = '456';
    return 'success';
  });
  assert.equal(result.outcome, 'success');
  assert.equal(db.read().outcomes.original, 'success');
  assert.equal(db.read().audit.find((item) => item.id === 'write:original').record.target, '123');
  assert.equal(Object.hasOwn(db.read().outcomes, 'different'), false);
});

test('读取结果投影抛错时以未知结算审计，不泄漏异常', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-sim-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-08T02:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, reads: 0, writes: 0, tools: { read_posts: true },
    readAttempts: {}, readOutcomes: {}, notices: [], browseDay: '2026-11-08', todayBrowses: 0,
    lastBrowseAt: null, usedOpportunities: {}, activeStart: 420, activeEnd: 1380, audit: [] });
  const req = { id: 'err', now, tool: 'read_posts', source: 'requested', target: '123', activeTime: false };
  const result = await simulator.simulateOfflineFriendRead(db, req, { friend: true, author: '123' }, async () => [
    { author: '123', id: 'p1', time: now, get content() { throw new Error('private-secret'); } },
  ]);
  assert.equal(result.outcome, 'unknown');
  assert.deepEqual(result.posts, []);
  assert.equal(db.read().readOutcomes.err, 'unknown');
  assert.equal(db.read().audit.find((item) => item.id === 'read:err').record.result, 'unknown');
  assert.equal(JSON.stringify(result).includes('private-secret'), false);
});
