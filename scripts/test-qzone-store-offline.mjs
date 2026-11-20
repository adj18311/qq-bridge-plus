import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../src/core/qzone-store-offline.mjs';

test('事务提交后新连接可读取，拒绝异步事务与异常回滚', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-store-test-'));
  let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'test.db');
  assert.equal(typeof store.openOfflineStore, 'function');
  db = store.openOfflineStore(file, { count: 0 });
  assert.deepEqual(db.read(), { count: 0 });
  db.update((state) => ({ count: state.count + 1 }));
  assert.throws(() => db.update(() => { throw new Error('abort'); }), /abort/);
  assert.throws(() => db.update(async () => ({ count: 9 })), /synchronous/);
  assert.deepEqual(db.read(), { count: 1 });
  const other = store.openOfflineStore(file, { count: 999 });
  try { assert.deepEqual(other.read(), { count: 1 }); } finally { other.close(); }
});

test('损坏状态不得重置为默认值，重复预留在同一事务内受限', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-store-test-'));
  let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(typeof store.openOfflineStore, 'function');
  db = store.openOfflineStore(join(dir, 'test.db'), { used: 0 });
  assert.throws(() => db.update(() => null), /state/);
  assert.deepEqual(db.read(), { used: 0 });
  db.update((s) => { if (s.used >= 1) throw new Error('limit'); return { used: s.used + 1 }; });
  assert.throws(() => db.update((s) => { if (s.used >= 1) throw new Error('limit'); return { used: s.used + 1 }; }), /limit/);
  assert.deepEqual(db.read(), { used: 1 });
});

test('多进程竞争同一额度最多成功一次', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'test.db');
  const db = store.openOfflineStore(file, { used: 0 });
  db.close();
  const moduleUrl = new URL('../src/core/qzone-store-offline.mjs', import.meta.url).href;
  const code = `import {openOfflineStore} from ${JSON.stringify(moduleUrl)}; const s=openOfflineStore(process.argv[1],{used:0}); try { s.update(x=>{ if(x.used>=1) throw Error('limit'); return {used:x.used+1}; }); process.exitCode=0; } catch(e) { if(e.message==='limit') process.exitCode=2; else throw e; } finally {s.close();}`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, file], { stdio: 'ignore' });
    child.on('error', reject); child.on('exit', (exitCode) => resolve(exitCode));
  });
  const codes = await Promise.all(Array.from({ length: 6 }, run));
  assert.equal(codes.filter((code) => code === 0).length, 1);
  assert.equal(codes.filter((code) => code === 2).length, 5);
  const verify = store.openOfflineStore(file, { used: 0 });
  try { assert.deepEqual(verify.read(), { used: 1 }); } finally { verify.close(); }
});

test('已有状态内容损坏时不覆盖成默认值', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'test.db');
  const first = store.openOfflineStore(file, { used: 1 }); first.close();
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE state SET value = ? WHERE id = 1').run('{bad json'); raw.close();
  const reopened = store.openOfflineStore(file, { used: 0 });
  try {
    assert.throws(() => reopened.read(), SyntaxError);
    assert.throws(() => reopened.update(() => ({ used: 0 })), SyntaxError);
    assert.throws(() => reopened.read(), SyntaxError);
  } finally { reopened.close(); }
});

test('进程在提交前被终止时事务不产生半次更新', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'test.db');
  const first = store.openOfflineStore(file, { used: 0 }); first.close();
  const code = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); db.prepare('UPDATE state SET value=? WHERE id=1').run('{"used":1}'); console.log('ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, file], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('child timeout')); }, 5000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`child exited early: ${code}`)); });
  });
  await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
  const reopened = store.openOfflineStore(file, { used: 9 });
  try { assert.deepEqual(reopened.read(), { used: 0 }); } finally { reopened.close(); }
});

test('状态必须是普通 JSON 对象，不接受 Date 或自定义 toJSON', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-store-test-'));
  let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = store.openOfflineStore(join(dir, 'test.db'), { used: 0 });
  assert.throws(() => db.update(() => new Date()), /state/);
  assert.throws(() => db.update(() => ({ toJSON() { return 42; } })), /state/);
  assert.deepEqual(db.read(), { used: 0 });
});

test('真实额度策略在事务内竞争时只发放一次预留', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'test.db');
  const initial = { day: '2026-11-07', used: { post: 0, comment: 0, like: 0 }, reservations: {} };
  const first = store.openOfflineStore(file, initial); first.close();
  const storeUrl = new URL('../src/core/qzone-store-offline.mjs', import.meta.url).href;
  const policyUrl = new URL('../src/core/qzone-policy-offline.mjs', import.meta.url).href;
  const code = `import {openOfflineStore} from ${JSON.stringify(storeUrl)}; import {reserveWrite} from ${JSON.stringify(policyUrl)}; const s=openOfflineStore(process.argv[1],${JSON.stringify(initial)}); try {s.update(x=>{const r=reserveWrite(x,{day:x.day,kind:'post',limit:1,id:process.argv[2]});if(!r.allowed)throw Error('limit');return r.state;});}catch(e){if(e.message==='limit')process.exitCode=2;else throw e;}finally{s.close();}`;
  const run = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, file, id], { stdio: 'ignore' });
    child.once('error', reject); child.once('exit', resolve);
  });
  const codes = await Promise.all(Array.from({ length: 6 }, (_, i) => run(`op-${i}`)));
  assert.equal(codes.filter((v) => v === 0).length, 1);
  assert.equal(codes.filter((v) => v === 2).length, 5);
  const final = store.openOfflineStore(file, initial);
  try { assert.equal(final.read().used.post, 1); assert.equal(Object.keys(final.read().reservations).length, 1); } finally { final.close(); }
});

test('已初始化数据库的状态行缺失时拒绝启动，不能恢复默认额度', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'test.db');
  const first = store.openOfflineStore(file, { used: 1 }); first.close();
  const raw = new DatabaseSync(file); raw.exec('DELETE FROM state'); raw.close();
  let reopened;
  try { assert.throws(() => { reopened = store.openOfflineStore(file, { used: 0 }); }, /missing state/); }
  finally { reopened?.close(); }
});

test('已存在的数据库状态表缺失时不得重新初始化配额和暂停状态', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'test.db');
  const first = store.openOfflineStore(file, { used: 2, writePaused: true }); first.close();
  const raw = new DatabaseSync(file); raw.exec('DROP TABLE state'); raw.close();
  let reopened;
  try { assert.throws(() => { reopened = store.openOfflineStore(file, { used: 0, writePaused: false }); }, /missing state/); }
  finally { reopened?.close(); }
});

test('已知凭据字段无论嵌套层级都不得写入状态库', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qzone-store-test-')); let db;
  t.after(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });
  db = store.openOfflineStore(join(dir, 'test.db'), { used: 0 });
  for (const key of ['cookie', 'p_skey', 'qzonetoken', 'access_token', 'apiKey', 'password']) {
    assert.throws(() => db.update(() => ({ used: 1, nested: [{ [key]: 'fake-secret' }] })), /sensitive/i);
    assert.deepEqual(db.read(), { used: 0 });
  }
  db.update((s) => ({ ...s, claimToken: 'operation-id' }));
  assert.equal(db.read().claimToken, 'operation-id');
});
