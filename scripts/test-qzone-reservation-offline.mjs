import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openOfflineStore } from '../src/core/qzone-store-offline.mjs';
import * as reservation from '../src/core/qzone-reservation-offline.mjs';

test('空间写入预留在持久事务中检查权限、每日额度和全局发帖间隔', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-reservation-'));
  let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const initial = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { publish: true }, limits: { post: 3 }, ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, lastPostAt: null };
  db = openOfflineStore(join(dir, 'state.db'), initial);
  assert.equal(typeof reservation.reserveOfflinePost, 'function');
  const request = { id: 'op1', now: Date.parse('2026-11-07T00:00:00Z') };
  assert.equal(reservation.reserveOfflinePost(db, request).allowed, true);
  assert.equal(db.read().ledger.used.post, 1);
  assert.equal(reservation.reserveOfflinePost(db, { ...request, id: 'op2', now: request.now + 7199999 }).allowed, false);
  assert.equal(db.read().ledger.used.post, 1);
  assert.equal(reservation.reserveOfflinePost(db, { ...request, id: 'op2', now: request.now + 7200000 }).allowed, true);
  db.update((s) => ({ ...s, writePaused: true }));
  assert.equal(reservation.reserveOfflinePost(db, { ...request, id: 'op3', now: request.now + 14400000 }).allowed, false);
  assert.equal(db.read().ledger.used.post, 2);
});

test('评论回复共享额度与全局间隔，不按说说去重；点赞同说说去重', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-reservation-'));
  let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, tools: { comment: true, reply: true, like: true },
    limits: { comment: 25, like: 30 }, ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, commentTargets: [], likes: [] });
  assert.equal(typeof reservation.reserveOfflineInteraction, 'function');
  const req = { id: 'a', now: Date.parse('2026-11-07T00:00:00Z'), target: '123', postId: 'p1', tool: 'comment' };
  assert.equal(reservation.reserveOfflineInteraction(db, req).allowed, true);
  assert.equal(reservation.reserveOfflineInteraction(db, { ...req, id: 'b', tool: 'reply', now: req.now + 179999 }).allowed, false);
  assert.equal(reservation.reserveOfflineInteraction(db, { ...req, id: 'b', tool: 'reply', now: req.now + 180000 }).allowed, true);
  assert.equal(db.read().ledger.used.comment, 2);
  assert.equal(reservation.reserveOfflineInteraction(db, { ...req, id: 'c', tool: 'like' }).allowed, true);
  assert.equal(reservation.reserveOfflineInteraction(db, { ...req, id: 'd', tool: 'like', now: req.now + 86400000 }).allowed, false);
  assert.equal(db.read().ledger.used.like, 1);
});

test('评论与回复在不同对象之间仍共享三分钟间隔，跨零点及重启保留', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-reservation-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'state.db');
  const initial = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { comment: true, reply: true, like: true }, limits: { comment: 25, like: 30 },
    ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, commentTargets: [], likes: [] };
  db = openOfflineStore(file, initial);
  const now = Date.parse('2026-11-07T15:59:00Z');
  const first = { id: 'a', now, target: '123', postId: 'p1', tool: 'comment' };
  assert.equal(reservation.reserveOfflineInteraction(db, first).allowed, true);
  db.close(); db = openOfflineStore(file, initial);
  const second = { id: 'b', now: now + 179999, target: '456', postId: 'p2', tool: 'reply' };
  assert.equal(reservation.reserveOfflineInteraction(db, second).allowed, false);
  assert.equal(reservation.reserveOfflineInteraction(db, { ...second, now: now + 180000 }).allowed, true);
  assert.equal(db.read().ledger.used.comment, 1);
  assert.equal(reservation.reserveOfflineInteraction(db, { ...second, id: 'c', tool: 'like', now: now + 180001 }).allowed, true);
});

test('旧版多对象冷却状态迁移时取最近一次，时钟倒退仍拒绝', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-reservation-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-07T00:00:00Z');
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true,
    accessPaused: false, writePaused: false, tools: { comment: true }, limits: { comment: 25 },
    ledger: { day: '2026-11-07', used: { post: 0, comment: 2, like: 0 }, reservations: {} },
    commentTargets: [{ target: '123', time: now }, { target: '456', time: now + 10000 }], likes: [] });
  const request = { id: 'a', now: now + 189999, target: '999', postId: 'p3', tool: 'comment' };
  assert.equal(reservation.reserveOfflineInteraction(db, request).allowed, false);
  assert.equal(reservation.reserveOfflineInteraction(db, { ...request, now: now + 190000 }).allowed, true);
  assert.equal(reservation.reserveOfflineInteraction(db, { ...request, id: 'b', now: now + 1 }).allowed, false);
});

test('多个进程同时评论不同对象时，全局间隔最多放行一次', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-reservation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.db');
  const initial = { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { comment: true }, limits: { comment: 25 }, ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, commentTargets: [], likes: [] };
  const first = openOfflineStore(file, initial); first.close();
  const storeUrl = new URL('../src/core/qzone-store-offline.mjs', import.meta.url).href;
  const policyUrl = new URL('../src/core/qzone-reservation-offline.mjs', import.meta.url).href;
  const code = `import {openOfflineStore} from ${JSON.stringify(storeUrl)}; import {reserveOfflineInteraction} from ${JSON.stringify(policyUrl)}; const s=openOfflineStore(process.argv[1],${JSON.stringify(initial)}); try {const r=reserveOfflineInteraction(s,{id:process.argv[2],now:1794009600000,target:process.argv[3],postId:'p1',tool:'comment'});process.exitCode=r.allowed?0:2;}finally{s.close();}`;
  const run = (i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, file, `op${i}`, `${100 + i}`], { stdio: 'ignore' });
    child.once('error', reject); child.once('exit', resolve);
  });
  const codes = await Promise.all(Array.from({ length: 6 }, (_, i) => run(i)));
  assert.equal(codes.filter((code) => code === 0).length, 1);
  assert.equal(codes.filter((code) => code === 2).length, 5);
  const verify = openOfflineStore(file, initial);
  try { assert.equal(verify.read().ledger.used.comment, 1); } finally { verify.close(); }
});

test('发帖预留与审计意图同一事务，审计无法写入时不消耗额度', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-reservation-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    selfId: '123', tools: { publish: true }, limits: { post: 3 }, ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, lastPostAt: null, audit: null });
  assert.equal(typeof reservation.reserveAuditedOfflinePost, 'function');
  const now = Date.parse('2026-11-07T00:00:00Z');
  const req = { id: 'a', now };
  const intent = { time: now, source: 'qq', target: '123', action: 'publish', content: 'hello', result: 'unknown' };
  assert.throws(() => reservation.reserveAuditedOfflinePost(db, req, intent));
  assert.equal(db.read().ledger.used.post, 0);
  assert.equal(db.read().lastPostAt, null);
  db.update((s) => ({ ...s, audit: [] }));
  assert.throws(() => reservation.reserveAuditedOfflinePost(db, { id: 'sk-abcdefghijklmnop', now }, intent));
  assert.equal(JSON.stringify(db.read()).includes('sk-abcdefghijklmnop'), false);
  assert.throws(() => reservation.reserveAuditedOfflinePost(db, req, { ...intent, target: '456' }));
  assert.throws(() => reservation.reserveAuditedOfflinePost(db, req, { ...intent, content: 'qzonetoken=secret' }));
  assert.equal(JSON.stringify(db.read()).includes('qzonetoken=secret'), false);
  assert.equal(JSON.stringify(db.read()).includes('[REDACTED]'), false);
  assert.equal(db.read().ledger.used.post, 0);
  assert.equal(db.read().audit.length, 0);
});

test('发帖预留只读取一次正文快照，getter 后续变化不能改写已校验意图', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-reservation-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'state.db');
  db = openOfflineStore(file, { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    selfId: '123', tools: { publish: true }, limits: { post: 3 }, ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, lastPostAt: null, audit: [] });
  const now = Date.parse('2026-11-07T00:00:00Z');
  let contentReads = 0;
  const input = { time: now, source: 'qq', target: '123', action: 'publish', result: 'unknown',
    get content() { contentReads++; return contentReads === 1 ? 'approved body' : 'qzonetoken=secret-after-first-read'; } };
  assert.equal(reservation.reserveAuditedOfflinePost(db, { id: 'getter', now }, input).allowed, true);
  assert.equal(db.read().audit[0].record.content, 'approved body');
  assert.equal(db.read().audit[0].record.redacted, false);
  assert.equal(contentReads, 1);
  assert.equal((await readFile(file)).includes(Buffer.from('secret-after-first-read')), false);
});

test('敏感互动正文 fail closed，不预留且原文不进入持久化状态', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-reservation-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'state.db');
  db = openOfflineStore(file, { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { comment: true }, limits: { comment: 25 }, ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, commentTargets: [], likes: [], audit: [] });
  const now = Date.parse('2026-11-07T00:00:00Z');
  const req = { id: 'sensitive', now, tool: 'comment', target: '123', postId: 'p1', source: 'qq' };
  const secret = 'Cookie: qzonetoken=private-value';
  const intent = { time: now, source: 'qq', target: '123', postId: 'p1', action: 'comment', content: secret, result: 'unknown' };
  assert.throws(() => reservation.reserveAuditedOfflineInteraction(db, req, intent));
  const persisted = JSON.stringify(db.read());
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes('private-value'), false);
  assert.equal((await readFile(file)).includes(Buffer.from('private-value')), false);
  assert.equal(db.read().ledger.used.comment, 0);
  assert.deepEqual(db.read().commentTargets, []);
  assert.equal(db.read().audit.length, 0);
});

test('发帖预留在事务启动时 request 被修改仍使用校验时的 id 快照', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-reservation-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    selfId: '123', tools: { publish: true }, limits: { post: 3 }, ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, lastPostAt: null, audit: [] });
  const now = Date.parse('2026-11-07T00:00:00Z');
  const request = { id: 'checked-id', now };
  const store = { update(fn) { request.id = 'swapped-id'; return db.update(fn); } };
  const intent = { time: now, source: 'qq', target: '123', action: 'publish', content: 'post body', result: 'unknown' };
  assert.equal(reservation.reserveAuditedOfflinePost(store, request, intent).allowed, true);
  assert.equal(db.read().ledger.reservations['checked-id'], 'post');
  assert.equal(Object.hasOwn(db.read().ledger.reservations, 'swapped-id'), false);
  assert.equal(db.read().audit[0].id, 'intent_checked-id');
});

test('互动预留在事务启动时 request 的 id、target、tool 被修改仍使用校验时快照', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-reservation-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { comment: true, like: true }, limits: { comment: 25, like: 30 },
    ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, commentTargets: [], likes: [], audit: [] });
  const now = Date.parse('2026-11-07T00:00:00Z');
  const request = { id: 'checked-id', now, tool: 'comment', target: '123', postId: 'p1', source: 'qq' };
  const store = { update(fn) { Object.assign(request, { id: 'swapped-id', tool: 'like', target: '456' }); return db.update(fn); } };
  const intent = { time: now, source: 'qq', target: '123', postId: 'p1', action: 'comment', content: 'comment body', result: 'unknown' };
  assert.equal(reservation.reserveAuditedOfflineInteraction(store, request, intent).allowed, true);
  assert.equal(db.read().ledger.reservations['checked-id'], 'comment');
  assert.equal(Object.hasOwn(db.read().ledger.reservations, 'swapped-id'), false);
  assert.deepEqual(db.read().commentTargets, [{ target: '123', time: now }]);
  assert.deepEqual(db.read().likes, []);
  assert.equal(db.read().audit[0].id, 'intent_checked-id');
  assert.equal(db.read().audit[0].record.target, '123');
});

test('评论、回复、点赞的额度预留和意图审计必须共同提交', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-reservation-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { comment: true, reply: true, like: true }, limits: { comment: 25, like: 30 },
    ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, commentTargets: [], likes: [], audit: null });
  assert.equal(typeof reservation.reserveAuditedOfflineInteraction, 'function');
  const now = Date.parse('2026-11-07T00:00:00Z');
  const req = { id: 'a', now, tool: 'comment', target: '123', postId: 'p1', source: 'qq' };
  const intent = { time: now, source: 'qq', target: '123', postId: 'p1', action: 'comment', content: 'hi', result: 'unknown' };
  assert.throws(() => reservation.reserveAuditedOfflineInteraction(db, req, intent));
  assert.equal(db.read().ledger.used.comment, 0);
  assert.deepEqual(db.read().commentTargets, []);
  db.update((s) => ({ ...s, audit: [] }));
  assert.throws(() => reservation.reserveAuditedOfflineInteraction(db, req, { ...intent, target: '456' }));
  assert.throws(() => reservation.reserveAuditedOfflineInteraction(db, req, { ...intent, source: 'patrol' }));
  assert.equal(reservation.reserveAuditedOfflineInteraction(db, req, intent).allowed, true);
  assert.equal(db.read().audit[0].id, 'intent_a');
  const likeReq = { ...req, id: 'b', tool: 'like' };
  assert.equal(reservation.reserveAuditedOfflineInteraction(db, likeReq, { ...intent, action: 'like' }).allowed, true);
  assert.equal(db.read().ledger.used.like, 1);
});

test('回复意图必须绑定具体评论标识，普通评论不能冒充回复', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-reservation-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = openOfflineStore(join(dir, 'state.db'), { enabled: true, readAllowed: true, writeAllowed: true, accessPaused: false, writePaused: false,
    tools: { reply: true, comment: true }, limits: { comment: 25 }, ledger: { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} }, commentTargets: [], likes: [], audit: [], commentEvidence: [] });
  const now = Date.parse('2026-11-07T00:00:00Z');
  const req = { id: 'a', now, tool: 'reply', target: '123', postId: 'p1', commentId: 'c1', source: 'qq' };
  const intent = { time: now, source: 'qq', target: '123', postId: 'p1', commentId: 'c1', action: 'reply', content: 'hi', result: 'unknown' };
  assert.throws(() => reservation.reserveAuditedOfflineInteraction(db, { ...req, commentId: undefined }, intent));
  assert.throws(() => reservation.reserveAuditedOfflineInteraction(db, req, { ...intent, commentId: 'c2' }));
  assert.throws(() => reservation.reserveAuditedOfflineInteraction(db, { ...req, tool: 'comment' }, { ...intent, action: 'comment' }));
  assert.equal(db.read().ledger.used.comment, 0);
  assert.equal(reservation.reserveAuditedOfflineInteraction(db, req, intent).allowed, false);
  // `at` is REQUIRED now: the reservation judges evidence age inside its own transaction, so a row
  // without a dateable stamp is refused as `evidence-undated` rather than treated as ageless. These
  // seeds therefore carry `at` — the same `now` the request uses, i.e. maximally fresh.
  db.update((s) => ({ ...s, commentEvidence: [{ target: '123', postId: 'p1', commentId: 'c2', at: now }] }));
  assert.equal(reservation.reserveAuditedOfflineInteraction(db, req, intent).allowed, false);
  db.update((s) => ({ ...s, commentEvidence: [{ target: '123', postId: 'p1', commentId: 'c1', at: now }] }));
  assert.equal(reservation.reserveAuditedOfflineInteraction(db, req, intent).allowed, true);
  assert.equal(db.read().audit[0].record.commentId, 'c1');
});
